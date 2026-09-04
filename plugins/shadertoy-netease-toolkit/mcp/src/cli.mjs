import { readFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ToolInputError,
  ToolRuntimeError,
  createRuntime,
  createToolRegistry,
  defaultDataDirectory,
} from './tools.mjs';

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_IMPORT_PROJECTS = 5_000;
const DEFAULT_FULL_SYNC_MAX_OPERATIONS = 100;
const MAX_FULL_SYNC_MAX_OPERATIONS = 1_500;
const DEFAULT_FULL_SYNC_BATCH_SIZE = 10;

export class CliInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliInputError';
  }
}

export function cliUsage() {
  return {
    status: 'ok',
    command: 'help',
    commands: {
      init: 'Create/open the default local library.',
      status: 'Show local library health.',
      search: 'search <query> [--limit N] [--offset N]',
      get: 'get <id> [--include-source --pass-index N --source-offset N --max-chars N]',
      refresh: 'refresh <id>',
      sync: 'sync [--limit N] | sync --full [--resume] [--limit N] [--max-operations N] (--limit is batch size; --max-operations 1..1500, default 100)',
      'import-json': 'import-json <explicit-local-json-path>',
    },
  };
}

/**
 * Execute a CLI command without writing to a stream.  Keeping this pure-ish
 * entry point lets protocol tests inject an in-memory store and avoids a
 * different validation path from MCP tools.
 */
export async function runCli(argv = process.argv.slice(2), options = {}) {
  if (!Array.isArray(argv)) {
    throw new TypeError('argv must be an array.');
  }
  const args = argv.map((arg) => String(arg));
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    if (args.length) {
      throw new CliInputError('help does not accept additional arguments.');
    }
    return cliUsage();
  }

  const environment = options.environment || process.env;
  const dataDir = options.dataDir || defaultDataDirectory(environment);
  const runtimeFactory = options.runtimeFactory || createRuntime;
  let runtime;
  try {
    if (command === 'init') {
      ensureNoArguments(args);
      await mkdir(dataDir, { recursive: true });
      runtime = await runtimeFactory({ ...options.runtimeOptions, environment, dataDir });
      await callRequired(runtime.store, 'status');
      return { status: 'ok', command };
    }

    runtime = await runtimeFactory({ ...options.runtimeOptions, environment, dataDir });
    const registry = createToolRegistry(runtime);
    switch (command) {
      case 'status':
        ensureNoArguments(args);
        return cliToolResponse(command, await registry.call('shadertoy_library_status', {}));
      case 'search':
        return cliToolResponse(command, await registry.call('search_shadertoy_library', parseSearch(args)));
      case 'get':
        return cliToolResponse(command, await registry.call('get_shadertoy_project', parseGet(args)));
      case 'refresh':
        return cliToolResponse(command, await registry.call('refresh_shadertoy_project', parseRefresh(args)));
      case 'sync':
        return await runSync(args, runtime, registry, command);
      case 'import-json':
        return await importJson(args, runtime, options.cwd || process.cwd(), command);
      default:
        throw new CliInputError(`Unknown command: ${command}.`);
    }
  } finally {
    if (runtime && options.closeRuntime !== false && typeof runtime.store?.close === 'function') {
      runtime.store.close();
    }
  }
}

function parseSearch(args) {
  const query = takePositional(args, 'search query');
  const flags = parseFlags(args, {
    limit: { type: 'integer' },
    offset: { type: 'integer' },
  });
  return {
    query,
    ...(flags.limit === undefined ? {} : { limit: flags.limit }),
    ...(flags.offset === undefined ? {} : { offset: flags.offset }),
  };
}

function parseGet(args) {
  const id = takePositional(args, 'project id');
  const flags = parseFlags(args, {
    'include-source': { type: 'boolean' },
    'pass-index': { type: 'integer' },
    'source-offset': { type: 'integer' },
    'max-chars': { type: 'integer' },
  });
  const includeSource = flags['include-source'] === true;
  const sourceFlagNames = ['pass-index', 'source-offset', 'max-chars'];
  const supplied = sourceFlagNames.filter((name) => flags[name] !== undefined);
  if (!includeSource && supplied.length) {
    throw new CliInputError('Source window flags require --include-source.');
  }
  if (includeSource && supplied.length !== sourceFlagNames.length) {
    throw new CliInputError('--include-source requires --pass-index, --source-offset, and --max-chars.');
  }
  return {
    id,
    ...(includeSource ? {
      include_source: true,
      pass_index: flags['pass-index'],
      source_offset: flags['source-offset'],
      max_chars: flags['max-chars'],
    } : {}),
  };
}

function parseRefresh(args) {
  const id = takePositional(args, 'project id');
  ensureNoArguments(args);
  return { id };
}

async function runSync(args, runtime, registry, command) {
  const flags = parseFlags(args, {
    full: { type: 'boolean' },
    resume: { type: 'boolean' },
    limit: { type: 'integer' },
    'max-operations': { type: 'integer' },
  });
  const limit = flags.limit;
  if (flags.resume && !flags.full) {
    throw new CliInputError('--resume requires --full.');
  }
  if (flags['max-operations'] !== undefined && !flags.full) {
    throw new CliInputError('--max-operations requires --full.');
  }
  if (!flags.full) {
    return cliToolResponse(command, await registry.call('sync_shadertoy_catalog_step', {
      ...(limit === undefined ? {} : { limit }),
    }));
  }
  const maxOperations = parseFullSyncMaxOperations(flags['max-operations']);

  if (!hasApiKey(runtime) || !runtime.client) {
    return {
      status: 'auth_required',
      command,
      isError: true,
      error: {
        code: 'auth_required',
        message: 'Set SHADERTOY_API_KEY in the CLI environment before full synchronization.',
      },
    };
  }
  return fullSync(runtime, {
    resume: Boolean(flags.resume),
    limit,
    maxOperations,
  }, command);
}

function parseFullSyncMaxOperations(value) {
  if (value === undefined) {
    return DEFAULT_FULL_SYNC_MAX_OPERATIONS;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FULL_SYNC_MAX_OPERATIONS) {
    throw new CliInputError(`--max-operations must be an integer between 1 and ${MAX_FULL_SYNC_MAX_OPERATIONS}.`);
  }
  return value;
}

async function fullSync(runtime, { resume, limit, maxOperations }, command) {
  let catalog = null;
  let consumed = 0;
  if (!resume) {
    if (typeof runtime.syncCatalog !== 'function') {
      throw new ToolRuntimeError('runtime_unavailable', 'Full catalog synchronization is unavailable.');
    }
    // Reserve the catalog listing before starting it. A listing is one logical
    // remote operation even when its client performs multiple HTTP attempts.
    consumed += 1;
    catalog = await runtime.syncCatalog(runtime.store, runtime.client, {
      resume: true,
      requestsPerSecond: 0.5,
      delayMs: 2_000,
    });
    if (!isSuccessfulSyncStatus(catalog?.status)) {
      return fullSyncResponse(catalog, fullSyncProgress({
        catalog,
        steps: 0,
        totals: {},
        budget: maxOperations,
        consumed,
        resumable: true,
      }), command);
    }
    if (consumed >= maxOperations) {
      return fullSyncBudgetExhaustedResponse(catalog, fullSyncProgress({
        catalog,
        steps: 0,
        totals: {},
        budget: maxOperations,
        consumed,
        resumable: true,
      }), command);
    }
  }
  if (typeof runtime.syncStep !== 'function') {
    throw new ToolRuntimeError('runtime_unavailable', 'Bounded catalog synchronization is unavailable.');
  }

  const totals = {};
  let last = null;
  let steps = 0;
  // Each underlying call remains bounded by runtime.syncStep. Cap its batch by
  // the remaining logical-operation budget so it cannot start more fetches than
  // this CLI invocation has reserved.
  while (consumed < maxOperations) {
    const remainingBeforeStep = maxOperations - consumed;
    const stepLimit = fullSyncStepLimit(limit, remainingBeforeStep);
    last = await runtime.syncStep(runtime.store, runtime.client, {
      limit: stepLimit,
      maxDurationMs: 30_000,
    });
    steps += 1;
    mergeNumericTotals(totals, last?.stats);
    consumed += logicalOperationsConsumedByStep(last, stepLimit);
    const failed = Number(last?.stats?.failed) || 0;
    const processed = Number(last?.stats?.processed) || 0;
    // A partial result with a recorded failure (or no progress before a time
    // budget expired) is deliberately left resumable for the next explicit
    // CLI run. Do not spin on the same failed pending entry in this process.
    if (!isSuccessfulSyncStatus(last?.status) || !last?.resumable || failed > 0 || processed === 0) {
      return fullSyncResponse(last, {
        catalog,
        steps,
        totals,
        budget: maxOperations,
        consumed,
        remaining: maxOperations - consumed,
        resumable: Boolean(last?.resumable),
      }, command);
    }
    if (consumed >= maxOperations) {
      return fullSyncBudgetExhaustedResponse(last, fullSyncProgress({
        catalog,
        steps,
        totals,
        budget: maxOperations,
        consumed,
        resumable: true,
      }), command);
    }
  }
  return fullSyncBudgetExhaustedResponse(last, fullSyncProgress({
    catalog,
    steps,
    totals,
    budget: maxOperations,
    consumed,
    resumable: true,
  }), command);
}

function fullSyncStepLimit(limit, remaining) {
  const requestedLimit = limit === undefined ? DEFAULT_FULL_SYNC_BATCH_SIZE : Math.max(1, limit);
  return Math.min(requestedLimit, remaining);
}

function logicalOperationsConsumedByStep(result, stepLimit) {
  const processed = nonNegativeInteger(result?.stats?.processed);
  const invalidIds = nonNegativeInteger(result?.stats?.invalidIds);
  // catalog.syncStep increments `processed` before validating the candidate.
  // Invalid IDs never call getShader, so do not count them as remote fetches.
  return Math.min(stepLimit, Math.max(0, processed - invalidIds));
}

function nonNegativeInteger(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function fullSyncProgress({ catalog, steps, totals, budget, consumed, resumable }) {
  return {
    catalog: boundedCliValue(catalog),
    steps,
    totals,
    budget,
    consumed,
    remaining: Math.max(0, budget - consumed),
    resumable,
  };
}

function fullSyncBudgetExhaustedResponse(last, progress, command) {
  const response = boundedCliValue(last && typeof last === 'object' ? last : {});
  return {
    ...response,
    status: 'partial',
    command,
    isError: true,
    error: {
      code: 'operation_budget_exhausted',
      message: 'Full synchronization reached its logical operation budget; rerun with --resume.',
    },
    resumable: true,
    progress: boundedCliValue(progress),
  };
}

function fullSyncResponse(last, progress, command) {
  const response = boundedCliValue(last && typeof last === 'object' ? last : { status: 'ok', result: last });
  const status = response.status || 'ok';
  return {
    ...response,
    command,
    progress: boundedCliValue(progress),
    ...(!isSuccessfulSyncStatus(status) || (status === 'partial' && Number(last?.stats?.failed) > 0)
      ? { isError: true }
      : {}),
  };
}

function isSuccessfulSyncStatus(status) {
  return status === 'ok' || status === 'success' || status === 'complete' || status === 'completed' || status === 'partial';
}

function mergeNumericTotals(target, source) {
  if (!source || typeof source !== 'object') {
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    if (Number.isFinite(value)) {
      target[key] = (target[key] || 0) + value;
    }
  }
}

async function importJson(args, runtime, cwd, command) {
  const suppliedPath = takePositional(args, 'local JSON path');
  ensureNoArguments(args);
  const localPath = resolveExplicitLocalPath(suppliedPath, cwd);
  const file = await stat(localPath);
  if (!file.isFile()) {
    throw new CliInputError('import-json requires a local JSON file.');
  }
  if (file.size > MAX_IMPORT_BYTES) {
    throw new CliInputError(`import-json file exceeds ${MAX_IMPORT_BYTES} bytes.`);
  }

  let decoded;
  try {
    decoded = JSON.parse(await readFile(localPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliInputError('import-json file is not valid JSON.');
    }
    throw error;
  }
  const entries = selectImportEntries(decoded);
  if (entries.length > MAX_IMPORT_PROJECTS) {
    throw new CliInputError(`import-json contains more than ${MAX_IMPORT_PROJECTS} projects.`);
  }

  let imported = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      skipped += 1;
      continue;
    }
    const project = typeof runtime.normalizeApiProject === 'function'
      ? runtime.normalizeApiProject(entry)
      : entry;
    if (!project || typeof project !== 'object') {
      skipped += 1;
      continue;
    }
    await callRequired(runtime.store, 'upsertProject', project);
    imported += 1;
  }
  return { status: 'ok', command, imported, skipped };
}

function selectImportEntries(decoded) {
  if (Array.isArray(decoded)) {
    return decoded;
  }
  if (decoded && typeof decoded === 'object') {
    if (decoded.Shader && typeof decoded.Shader === 'object' && !Array.isArray(decoded.Shader)) {
      return [decoded];
    }
    for (const key of ['projects', 'shaders', 'Shaders']) {
      if (Array.isArray(decoded[key])) {
        return decoded[key];
      }
    }
  }
  throw new CliInputError('import-json must contain an array or a projects/shaders/Shaders array.');
}

function resolveExplicitLocalPath(value, cwd) {
  const windowsSeparators = typeof value === 'string' ? value.replace(/\//g, '\\') : '';
  const isUncOrDevicePath = /^\\\\/.test(windowsSeparators) || /^\\\?\?\\/.test(windowsSeparators);
  if (!value || value.includes('\0') || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value) || /^file:/i.test(value) || isUncOrDevicePath) {
    throw new CliInputError('import-json accepts only an explicit local filesystem path.');
  }
  const resolved = path.resolve(cwd, value);
  const resolvedWindows = resolved.replace(/\//g, '\\');
  if (/^\\\\/.test(resolvedWindows) || /^\\\?\?\\/.test(resolvedWindows)) {
    throw new CliInputError('import-json accepts only an explicit local filesystem path.');
  }
  return resolved;
}

function cliToolResponse(command, toolResult) {
  const payload = toolResult?.structuredContent;
  if (!payload || typeof payload !== 'object') {
    throw new ToolRuntimeError('invalid_tool_response', 'The local tool returned an invalid response.');
  }
  return {
    ...boundedCliValue(payload),
    command,
    ...(toolResult.isError ? { isError: true } : {}),
  };
}

function takePositional(args, label) {
  const value = args.shift();
  if (!value || value.startsWith('--')) {
    throw new CliInputError(`${label} is required.`);
  }
  return value;
}

function ensureNoArguments(args) {
  if (args.length) {
    throw new CliInputError(`Unexpected argument: ${args[0]}.`);
  }
}

function parseFlags(args, schema) {
  const result = {};
  while (args.length) {
    const token = args.shift();
    if (!token.startsWith('--')) {
      throw new CliInputError(`Unexpected argument: ${token}.`);
    }
    const [rawName, inline] = token.slice(2).split('=', 2);
    const rule = schema[rawName];
    if (!rule || Object.prototype.hasOwnProperty.call(result, rawName)) {
      throw new CliInputError(`Unsupported or duplicate option: --${rawName}.`);
    }
    if (rule.type === 'boolean') {
      if (inline !== undefined) {
        throw new CliInputError(`--${rawName} does not accept a value.`);
      }
      result[rawName] = true;
      continue;
    }
    const rawValue = inline === undefined ? args.shift() : inline;
    if (rawValue === undefined || rawValue.startsWith('--')) {
      throw new CliInputError(`--${rawName} requires a value.`);
    }
    if (rule.type === 'integer') {
      if (!/^-?\d+$/.test(rawValue)) {
        throw new CliInputError(`--${rawName} must be an integer.`);
      }
      result[rawName] = Number(rawValue);
    }
  }
  return result;
}

function hasApiKey(runtime) {
  return typeof runtime.apiKey === 'string' && runtime.apiKey.trim().length > 0;
}

async function callRequired(target, method, ...args) {
  if (!target || typeof target[method] !== 'function') {
    throw new ToolRuntimeError('runtime_unavailable', `The required local ${method} operation is unavailable.`);
  }
  return target[method](...args);
}

function boundedCliValue(value) {
  const encoded = JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
  if (encoded.length <= 128 * 1024) {
    return JSON.parse(encoded);
  }
  return { summary: `${encoded.slice(0, 128 * 1024 - 16)}… [truncated]`, truncated: true };
}

async function main() {
  try {
    const result = await runCli();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.isError) {
      process.exitCode = 1;
    }
  } catch (error) {
    const inputError = error instanceof CliInputError || error instanceof ToolInputError;
    const code = inputError ? 'invalid_input' : error instanceof ToolRuntimeError ? error.code : 'operation_failed';
    const message = inputError ? error.message : 'The command could not be completed.';
    process.stdout.write(`${JSON.stringify({ status: code, error: { code, message } })}\n`);
    process.exitCode = inputError ? 2 : 1;
  }
}

const invokedDirectly = Boolean(process.argv[1])
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main();
}
