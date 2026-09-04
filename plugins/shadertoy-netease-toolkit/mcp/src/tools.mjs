import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The MCP boundary deliberately accepts a small, explicit vocabulary.  The
 * store and API modules may evolve independently, but no tool accepts a URL,
 * filesystem path, or SQL fragment from an MCP client.
 */
const MAX_QUERY_LENGTH = 200;
const MAX_SOURCE_LENGTH = 2 * 1024 * 1024;
const MAX_SOURCE_WINDOW_CHARS = 32_768;
const MAX_ANALYSIS_TEXT_CHARS = 64 * 1024;
const MAX_ANALYSIS_ARRAY_ITEMS = 200;
const MAX_METADATA_TEXT_CHARS = 16 * 1024;
const MAX_PROTOCOL_STRING_CHARS = 32_768;
const MAX_PROTOCOL_ARRAY_ITEMS = 200;
const MAX_PROTOCOL_OBJECT_KEYS = 100;
const MAX_TOOL_CONTENT_BYTES = 128 * 1024;
const DEFAULT_MCP_SYNC_STEP_LIMIT = 3;
const MAX_MCP_SYNC_STEP_LIMIT = 10;
const MAX_OFFSET = 10_000;
const DEFAULT_RANK_LIMIT = 10;
const MAX_RANK_CANDIDATES = 25;
const SYNC_STEP_TIMEOUT_MS = 30_000;
const SHADER_ID_PATTERN = /^[A-Za-z0-9]{6}$/;

export class ToolInputError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ToolInputError';
    this.details = details;
  }
}

export class ToolRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolRuntimeError';
    this.code = code;
  }
}

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'shadertoy_library_status',
    description: 'Return local library health and whether the Shadertoy API key is configured.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'search_shadertoy_library',
    description: 'Search the local Shadertoy project library. This never fetches an arbitrary remote URL.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH, pattern: '\\S' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        offset: { type: 'integer', minimum: 0, maximum: MAX_OFFSET, default: 0 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_shadertoy_project',
    description: 'Get one cached Shadertoy project by its six-character Shadertoy id. Source is omitted unless one bounded pass window is explicitly requested.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9]{6}$' },
        include_source: { type: 'boolean', default: false, description: 'Set true only with all three source-window fields.' },
        pass_index: { type: 'integer', minimum: 0, maximum: 31, description: 'Required when include_source is true.' },
        source_offset: { type: 'integer', minimum: 0, maximum: MAX_SOURCE_LENGTH, description: 'Required character offset when include_source is true.' },
        max_chars: { type: 'integer', minimum: 1, maximum: MAX_SOURCE_WINDOW_CHARS, description: 'Required source-window size when include_source is true; maximum 32768 characters.' },
      },
      required: ['id'],
      oneOf: [
        {
          properties: { include_source: { const: false } },
          not: {
            anyOf: [
              { required: ['pass_index'] },
              { required: ['source_offset'] },
              { required: ['max_chars'] },
            ],
          },
        },
        {
          properties: { include_source: { const: true } },
          required: ['include_source', 'pass_index', 'source_offset', 'max_chars'],
        },
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'refresh_shadertoy_project',
    description: 'Refresh one known Shadertoy project through the configured official API key.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9]{6}$' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'sync_shadertoy_catalog_step',
    description: 'Synchronize at most 10 catalog records in one bounded API step.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_MCP_SYNC_STEP_LIMIT,
          default: DEFAULT_MCP_SYNC_STEP_LIMIT,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'analyze_shadertoy_source',
    description: 'Analyze supplied GLSL source locally for Shadertoy-to-NetEase porting risks.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', minLength: 1, maxLength: MAX_SOURCE_LENGTH },
        target: { type: 'string', enum: ['unknown', 'gles100', 'gles300'], default: 'unknown' },
      },
      required: ['source'],
      additionalProperties: false,
    },
  },
  {
    name: 'rank_netease_candidates',
    description: 'Heuristically rank cached projects from stored local analysis; this does not compile or run shaders.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH, pattern: '\\S' },
        ids: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_RANK_CANDIDATES,
          uniqueItems: true,
          items: { type: 'string', pattern: '^[A-Za-z0-9]{6}$' },
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RANK_CANDIDATES, default: DEFAULT_RANK_LIMIT },
        target: { type: 'string', enum: ['unknown', 'gles100', 'gles300'], default: 'unknown' },
      },
      anyOf: [{ required: ['query'] }, { required: ['ids'] }],
      additionalProperties: false,
    },
  },
]);

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));

export function defaultDataDirectory(environment = process.env) {
  const explicitDataDir = typeof environment.SHADERTOY_DATA_DIR === 'string'
    ? environment.SHADERTOY_DATA_DIR.trim()
    : '';
  if (explicitDataDir) {
    return explicitDataDir;
  }
  const codexHome = typeof environment.CODEX_HOME === 'string' ? environment.CODEX_HOME.trim() : '';
  if (codexHome) {
    return path.join(codexHome, 'data', 'shadertoy-netease');
  }
  const userHome = typeof environment.USERPROFILE === 'string' && environment.USERPROFILE.trim()
    ? environment.USERPROFILE.trim()
    : typeof environment.HOME === 'string' && environment.HOME.trim()
      ? environment.HOME.trim()
      : '';
  return userHome
    ? path.join(userHome, '.codex', 'data', 'shadertoy-netease')
    : path.join(process.cwd(), '.codex', 'data', 'shadertoy-netease');
}

/**
 * Create the concrete runtime lazily.  Keeping this adapter here makes the
 * protocol usable with injected fakes in tests and avoids importing the API
 * client merely to answer an offline library status request.
 */
export async function createRuntime(options = {}) {
  const environment = options.environment || process.env;
  const dataDir = options.dataDir || defaultDataDirectory(environment);
  const apiKey = typeof options.apiKey === 'string'
    ? options.apiKey.trim()
    : typeof environment.SHADERTOY_API_KEY === 'string'
      ? environment.SHADERTOY_API_KEY.trim()
      : '';

  // Create the complete default store path before loading or constructing the
  // SQLite adapter. A no-key status/search request must succeed on a brand-new
  // nested SHADERTOY_DATA_DIR as well as on an existing library.
  if (!options.store) {
    await mkdir(dataDir, { recursive: true });
  }

  const storeModule = options.storeModule || await importFirst([
    './db.mjs',
    './library-store.mjs',
    './store.mjs',
  ]);
  const apiModule = options.apiModule || await importFirst([
    './shadertoy-api.mjs',
    './api.mjs',
  ]);
  const catalogModule = options.catalogModule || await importFirst([
    './catalog.mjs',
  ]);
  const analyzerModule = options.analyzerModule || await importFirst([
    './analyzer.mjs',
    './source-analyzer.mjs',
  ]);

  let store = options.store;
  if (!store) {
    const LibraryStore = options.LibraryStore || storeModule?.LibraryStore;
    if (!LibraryStore) {
      throw new ToolRuntimeError('runtime_unavailable', 'The local library store is unavailable.');
    }
    store = createStore(LibraryStore, path.join(dataDir, 'library.sqlite3'));
  }

  let client = options.client;
  if (!client && apiKey) {
    const ShadertoyApiClient = options.ShadertoyApiClient || apiModule?.ShadertoyApiClient;
    if (ShadertoyApiClient) {
      client = new ShadertoyApiClient({ apiKey, fetch: options.fetch, ratePerSecond: 0.5 });
    }
  }

  return {
    store,
    client,
    apiKey,
    dataDir,
    normalizeApiProject: options.normalizeApiProject || catalogModule?.normalizeApiProject || apiModule?.normalizeApiProject,
    syncCatalog: options.syncCatalog || catalogModule?.syncCatalog,
    syncStep: options.syncStep || catalogModule?.syncStep,
    analyzer: options.analyzer || analyzerModule,
  };
}

function createStore(LibraryStore, databasePath) {
  try {
    return new LibraryStore({ path: databasePath });
  } catch (error) {
    // The documented implementation accepts an options object.  The fallback
    // keeps the adapter compatible with a previous single-path constructor
    // without hiding unrelated constructor failures.
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return new LibraryStore(databasePath);
  }
}

async function importFirst(paths) {
  for (const candidate of paths) {
    try {
      return await import(candidate);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') {
        throw error;
      }
    }
  }
  return undefined;
}

export function createToolRegistry(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    throw new TypeError('A tool runtime is required.');
  }

  return Object.freeze({
    list: () => TOOL_DEFINITIONS,
    has: (name) => TOOL_NAMES.has(name),
    async call(name, input = {}) {
      const args = validateToolInput(name, input);
      try {
        switch (name) {
          case 'shadertoy_library_status':
            return successResult(await libraryStatus(runtime));
          case 'search_shadertoy_library':
            return successResult(await searchLibrary(runtime, args));
          case 'get_shadertoy_project':
            return await getProject(runtime, args);
          case 'refresh_shadertoy_project':
            return await refreshProject(runtime, args);
          case 'sync_shadertoy_catalog_step':
            return await syncCatalogStep(runtime, args);
          case 'analyze_shadertoy_source':
            return await analyzeSource(runtime, args);
          case 'rank_netease_candidates':
            return await rankCandidates(runtime, args);
          default:
            return failureResult('unknown_tool', 'The requested tool is not available.');
        }
      } catch (error) {
        if (error instanceof ToolInputError) {
          throw error;
        }
        return failureFromError(error);
      }
    },
  });
}

export function validateToolInput(name, input) {
  if (!TOOL_NAMES.has(name)) {
    throw new ToolInputError('Unknown tool name.', { name });
  }
  const value = assertPlainObject(input, 'Tool arguments must be an object.');

  switch (name) {
    case 'shadertoy_library_status':
      assertKnownKeys(value, []);
      return {};
    case 'search_shadertoy_library':
      assertKnownKeys(value, ['query', 'limit', 'offset']);
      return {
        query: readText(value, 'query', { required: true, maxLength: MAX_QUERY_LENGTH }),
        limit: readInteger(value, 'limit', { defaultValue: 20, min: 1, max: 50 }),
        offset: readInteger(value, 'offset', { defaultValue: 0, min: 0, max: MAX_OFFSET }),
      };
    case 'get_shadertoy_project':
    case 'refresh_shadertoy_project':
      if (name === 'get_shadertoy_project') {
        return validateGetProjectInput(value);
      }
      assertKnownKeys(value, ['id']);
      return { id: readShaderId(value, 'id') };
    case 'sync_shadertoy_catalog_step':
      assertKnownKeys(value, ['limit']);
      return {
        limit: readInteger(value, 'limit', {
          defaultValue: DEFAULT_MCP_SYNC_STEP_LIMIT,
          min: 1,
          max: MAX_MCP_SYNC_STEP_LIMIT,
        }),
      };
    case 'analyze_shadertoy_source':
      assertKnownKeys(value, ['source', 'target']);
      return {
        source: readText(value, 'source', {
          required: true,
          maxLength: MAX_SOURCE_LENGTH,
          maxBytes: MAX_SOURCE_LENGTH,
          trim: false,
        }),
        target: readEnum(value, 'target', ['unknown', 'gles100', 'gles300'], 'unknown'),
      };
    case 'rank_netease_candidates':
      assertKnownKeys(value, ['query', 'ids', 'limit', 'target']);
      return validateRankInput(value);
    default:
      throw new ToolInputError('Unknown tool name.', { name });
  }
}

function validateRankInput(value) {
  const hasQuery = Object.prototype.hasOwnProperty.call(value, 'query');
  const hasIds = Object.prototype.hasOwnProperty.call(value, 'ids');
  if (!hasQuery && !hasIds) {
    throw new ToolInputError('Provide either query or ids.');
  }

  const result = {
    limit: readInteger(value, 'limit', {
      defaultValue: DEFAULT_RANK_LIMIT,
      min: 1,
      max: MAX_RANK_CANDIDATES,
    }),
    target: readEnum(value, 'target', ['unknown', 'gles100', 'gles300'], 'unknown'),
  };
  if (hasQuery) {
    result.query = readText(value, 'query', { required: true, maxLength: MAX_QUERY_LENGTH });
  }
  if (hasIds) {
    if (!Array.isArray(value.ids) || value.ids.length < 1 || value.ids.length > MAX_RANK_CANDIDATES) {
      throw new ToolInputError(`ids must contain between 1 and ${MAX_RANK_CANDIDATES} entries.`);
    }
    const ids = value.ids.map((id, index) => readShaderIdValue(id, `ids[${index}]`));
    if (new Set(ids).size !== ids.length) {
      throw new ToolInputError('ids must not contain duplicates.');
    }
    result.ids = ids;
  }
  return result;
}

function validateGetProjectInput(value) {
  assertKnownKeys(value, ['id', 'include_source', 'pass_index', 'source_offset', 'max_chars']);
  const result = { id: readShaderId(value, 'id') };
  const includeSource = Object.prototype.hasOwnProperty.call(value, 'include_source')
    ? value.include_source
    : false;
  if (typeof includeSource !== 'boolean') {
    throw new ToolInputError('include_source must be a boolean.');
  }
  result.includeSource = includeSource;

  const sourceKeys = ['pass_index', 'source_offset', 'max_chars'];
  const suppliedSourceKeys = sourceKeys.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (!includeSource && suppliedSourceKeys.length) {
    throw new ToolInputError('Source window options require include_source=true.');
  }
  if (!includeSource) {
    return result;
  }
  if (suppliedSourceKeys.length !== sourceKeys.length) {
    throw new ToolInputError('include_source=true requires pass_index, source_offset, and max_chars.');
  }
  result.passIndex = readInteger(value, 'pass_index', { defaultValue: undefined, min: 0, max: 31 });
  result.sourceOffset = readInteger(value, 'source_offset', { defaultValue: undefined, min: 0, max: MAX_SOURCE_LENGTH });
  result.maxChars = readInteger(value, 'max_chars', { defaultValue: undefined, min: 1, max: MAX_SOURCE_WINDOW_CHARS });
  return result;
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ToolInputError(message);
  }
  return value;
}

function assertKnownKeys(value, allowed) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new ToolInputError('Tool arguments contain unsupported properties.', { properties: unexpected });
  }
}

function readText(value, key, { required = false, maxLength, maxBytes, trim = true } = {}) {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    if (required) {
      throw new ToolInputError(`${key} is required.`);
    }
    return undefined;
  }
  if (typeof value[key] !== 'string') {
    throw new ToolInputError(`${key} must be a string.`);
  }
  const text = trim ? value[key].trim() : value[key];
  if (!text.length) {
    throw new ToolInputError(`${key} must not be empty.`);
  }
  if (maxLength !== undefined && text.length > maxLength) {
    throw new ToolInputError(`${key} must not exceed ${maxLength} characters.`);
  }
  if (maxBytes !== undefined && Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new ToolInputError(`${key} must not exceed ${maxBytes} UTF-8 bytes.`);
  }
  return text;
}

function readInteger(value, key, { defaultValue, min, max }) {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return defaultValue;
  }
  const integer = value[key];
  if (!Number.isSafeInteger(integer) || integer < min || integer > max) {
    throw new ToolInputError(`${key} must be an integer between ${min} and ${max}.`);
  }
  return integer;
}

function readEnum(value, key, choices, defaultValue) {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return defaultValue;
  }
  if (typeof value[key] !== 'string' || !choices.includes(value[key])) {
    throw new ToolInputError(`${key} must be one of: ${choices.join(', ')}.`);
  }
  return value[key];
}

function readShaderId(value, key) {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new ToolInputError(`${key} is required.`);
  }
  return readShaderIdValue(value[key], key);
}

function readShaderIdValue(value, key) {
  if (typeof value !== 'string') {
    throw new ToolInputError(`${key} must be a string.`);
  }
  if (!value.length) {
    throw new ToolInputError(`${key} is required.`);
  }
  if (!SHADER_ID_PATTERN.test(value)) {
    throw new ToolInputError(`${key} must be a six-character Shadertoy id.`);
  }
  return value;
}

async function libraryStatus(runtime) {
  const status = await callRequired(runtime.store, 'status');
  return {
    status: 'ok',
    library: boundedMetadata(status || {}),
    auth: { status: hasApiKey(runtime) ? 'configured' : 'auth_required' },
  };
}

async function searchLibrary(runtime, args) {
  const results = await callRequired(runtime.store, 'search', args.query, {
    limit: args.limit,
    offset: args.offset,
  });
  return {
    status: 'ok',
    query: args.query,
    limit: args.limit,
    offset: args.offset,
    results: Array.isArray(results) ? results.map((project) => projectForMcp(project)) : [],
  };
}

async function getProject(runtime, args) {
  const project = await callRequired(runtime.store, 'getProject', args.id);
  if (!project) {
    return failureResult('not_found', 'No cached project exists for this id.', { id: args.id });
  }
  const response = {
    status: 'ok',
    project: projectForMcp(project),
    attribution: attributionFor(project, args.id),
  };
  if (args.includeSource) {
    response.source = sourceWindowFor(project, args);
  }
  return successResult(response);
}

async function refreshProject(runtime, args) {
  const auth = requireApi(runtime);
  if (auth) {
    return auth;
  }
  const payload = await callRequired(runtime.client, 'getShader', args.id);
  const project = typeof runtime.normalizeApiProject === 'function'
    ? runtime.normalizeApiProject(payload)
    : payload;
  if (!project || typeof project !== 'object') {
    throw new ToolRuntimeError('invalid_upstream_response', 'The API returned an invalid project.');
  }
  if (project.id !== args.id) {
    throw new ToolRuntimeError('id_mismatch', 'The API returned a project different from the requested id.');
  }
  const write = await callRequired(runtime.store, 'upsertProject', project);
  const storedProject = await callRequired(runtime.store, 'getProject', args.id);
  if (!storedProject) {
    throw new ToolRuntimeError('store_write_failed', 'The refreshed project could not be read from the local library.');
  }
  return successResult({
    status: 'ok',
    projectId: args.id,
    write: boundedMetadata(write || {}),
    project: projectForMcp(storedProject),
    attribution: attributionFor(storedProject, args.id),
  });
}

async function syncCatalogStep(runtime, args) {
  const auth = requireApi(runtime);
  if (auth) {
    return auth;
  }
  if (typeof runtime.syncStep !== 'function') {
    throw new ToolRuntimeError('runtime_unavailable', 'Catalog synchronization is unavailable.');
  }
  const timeoutMs = syncTimeoutFor(runtime);
  const result = await withTimeout(
    (signal) => runtime.syncStep(runtime.store, runtime.client, {
      limit: args.limit,
      maxDurationMs: timeoutMs,
      signal,
    }),
    timeoutMs,
  );
  return resultFromOperation(result);
}

function syncTimeoutFor(runtime) {
  // This is intentionally an injected-runtime seam for tests, not an MCP
  // argument. Production calls retain the fixed 30-second step budget.
  const configured = runtime?.syncStepTimeoutMs;
  return Number.isSafeInteger(configured) && configured > 0 && configured <= SYNC_STEP_TIMEOUT_MS
    ? configured
    : SYNC_STEP_TIMEOUT_MS;
}

async function analyzeSource(runtime, args) {
  const analyzer = resolveAnalyzer(runtime.analyzer, ['analyzeShadertoySource', 'analyzeSource', 'analyze']);
  const analysis = await analyzer(args.source, { target: args.target });
  return successResult({ status: 'ok', analysis: boundedAnalysis(analysis) });
}

async function rankCandidates(runtime, args) {
  let selected = [];
  if (args.ids) {
    const found = await Promise.all(args.ids.map((id) => callRequired(runtime.store, 'getProject', id)));
    selected = found.filter(Boolean);
  }
  if (args.query) {
    // Explicit ids are already bounded and locally loaded. Filtering those
    // records directly avoids a top-N FTS search accidentally excluding an
    // explicitly named matching candidate before the intersection is taken.
    if (args.ids) {
      selected = selected.filter((project) => projectMatchesQuery(project, args.query));
    } else {
      const searchResults = await callRequired(runtime.store, 'search', args.query, {
        limit: MAX_RANK_CANDIDATES,
        offset: 0,
      });
      selected = await hydrateSearchCandidates(runtime.store, searchResults);
    }
  }

  const ranked = rankFromStoredAnalysis(selected, args).slice(0, args.limit);
  return successResult({
    status: 'ok',
    heuristic: true,
    note: 'Ranking uses stored local analysis only. It is not GLSL compilation, NetEase route verification, MCDK, or in-game validation.',
    selected: selected.length,
    candidates: ranked.map((candidate) => boundedRankCandidate(candidate)),
  });
}

function boundedRankCandidate(candidate) {
  return sanitizeForMcp(candidate, {
    maxStringLength: 1_024,
    maxArrayItems: 40,
    maxObjectKeys: 40,
    maxDepth: 8,
    removeSourceFields: true,
    removeLocationFields: true,
  });
}

function projectMatchesQuery(project, query) {
  const parts = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const tags = Array.isArray(project?.tags) ? project.tags.filter((tag) => typeof tag === 'string') : [];
  const haystack = [project?.id, project?.title, project?.author, project?.description, ...tags]
    .filter((value) => typeof value === 'string')
    .join('\n')
    .toLocaleLowerCase();
  return parts.every((part) => haystack.includes(part));
}

async function hydrateSearchCandidates(store, values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const candidates = [];
  for (const value of values) {
    const id = typeof value?.id === 'string' ? value.id : null;
    if (!id || typeof store?.getProject !== 'function') {
      candidates.push(value);
      continue;
    }
    const project = await store.getProject(id);
    candidates.push(project || value);
  }
  return candidates;
}

function rankFromStoredAnalysis(candidates, args) {
  return candidates
    .map((project) => rankOneCandidate(project, args.target))
    .sort((left, right) => right.score - left.score || String(left.id).localeCompare(String(right.id)));
}

function rankOneCandidate(project, target) {
  const hasStoredAnalysis = Boolean(project?.analysis && typeof project.analysis === 'object');
  const analysis = hasStoredAnalysis ? project.analysis : {};
  const findings = Array.isArray(analysis.findings) ? analysis.findings : [];
  const severity = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) {
    if (finding && typeof finding.severity === 'string' && Object.prototype.hasOwnProperty.call(severity, finding.severity)) {
      severity[finding.severity] += 1;
    }
  }
  const costLevel = typeof analysis.costLevel === 'string'
    ? analysis.costLevel
    : typeof analysis.cost?.level === 'string'
      ? analysis.cost.level
      : 'unknown';
  const costPenalty = {
    low: 0,
    medium: 12,
    high: 28,
    'very-high': 45,
    unknown: 45,
  }[costLevel] ?? 45;
  const feedback = Boolean(analysis.feedback || analysis.graph?.hasFeedback || analysis.passGraph?.hasFeedback);
  const passCount = Array.isArray(analysis.passes)
    ? analysis.passes.length
    : findPasses(project).length;
  const targetAdjustment = targetScoreAdjustment(analysis, target);
  const noPassPenalty = passCount === 0 ? 70 : 0;
  const score = Math.max(0, Math.min(100,
    100 - costPenalty - severity.error * 20 - severity.warning * 5 - (feedback ? 25 : 0) - noPassPenalty + targetAdjustment.delta,
  ));
  const reasons = [];
  if (!hasStoredAnalysis) {
    reasons.push('No stored analysis is available; the score uses a conservative unknown-cost baseline.');
  } else {
    reasons.push(`Stored analysis reports ${costLevel} estimated cost.`);
  }
  if (passCount === 0) {
    reasons.push('No render passes are stored, so this cannot be prioritized as a feasible shader candidate.');
  }
  if (feedback) {
    reasons.push('Stored analysis reports a feedback/pass cycle that requires an explicitly supported target route.');
  }
  if (severity.error) {
    reasons.push(`${severity.error} stored error-level finding(s) lower the heuristic priority.`);
  }
  if (severity.warning) {
    reasons.push(`${severity.warning} stored warning-level finding(s) lower the heuristic priority.`);
  }
  if (!feedback && !severity.error && !severity.warning) {
    reasons.push('No stored feedback cycle or error/warning finding reduces the heuristic score.');
  }
  reasons.push(...targetAdjustment.reasons);
  return {
    id: typeof project?.id === 'string' ? project.id : null,
    title: typeof project?.title === 'string' ? truncateText(project.title, 512) : '',
    author: typeof project?.author === 'string' ? truncateText(project.author, 512) : 'unknown',
    score,
    priority: score >= 80 ? 'higher' : score >= 55 ? 'medium' : 'lower',
    heuristic: true,
    reasons,
    cost: {
      level: costLevel,
      score: Number.isFinite(analysis.cost?.score) ? analysis.cost.score : null,
      feedback,
      pass_count: passCount,
      analysis_status: typeof analysis.status === 'string' ? analysis.status : 'unavailable',
      findings: severity,
    },
    target: {
      baseline: target,
      score_adjustment: targetAdjustment.delta,
      constraints: targetAdjustment.constraints,
      compile_validation: 'not_run',
      runtime_validation: 'not_run',
    },
  };
}

function targetScoreAdjustment(analysis, target) {
  if (target === 'unknown') {
    return { delta: 0, constraints: [], reasons: ['No target dialect constraint was requested.'] };
  }
  const constraints = [];
  let delta = 0;
  const derivatives = Array.isArray(analysis.derivatives) ? analysis.derivatives.length : 0;
  const dynamicIndexing = Array.isArray(analysis.dynamicIndexing) ? analysis.dynamicIndexing.length : 0;
  const textureCalls = Array.isArray(analysis.textureCalls) ? analysis.textureCalls : [];
  const version = Number(analysis.version?.number);
  if (target === 'gles100') {
    if (derivatives) {
      constraints.push('derivatives');
      delta -= 10;
    }
    if (dynamicIndexing) {
      constraints.push('dynamic_array_indexing');
      delta -= 12;
    }
    if (textureCalls.some((call) => ['texelFetch', 'textureLod', 'textureGrad'].includes(call?.name))) {
      constraints.push('advanced_texture_sampling');
      delta -= 10;
    }
    if (Number.isFinite(version) && version >= 300) {
      constraints.push('glsl_300_or_newer');
      delta -= 8;
    }
  } else if (target === 'gles300' && Number.isFinite(version) && version > 0 && version < 300) {
    constraints.push('legacy_glsl_version');
    delta -= 3;
  }
  const reasons = constraints.length
    ? [`Target ${target} adds a ${Math.abs(delta)}-point heuristic constraint penalty: ${constraints.join(', ')}.`]
    : [`Stored analysis exposes no additional ${target} constraint penalty.`];
  return { delta, constraints, reasons };
}

function resolveAnalyzer(analyzer, names) {
  const resolved = findAnalyzer(analyzer, names);
  if (resolved) {
    return resolved;
  }
  throw new ToolRuntimeError('runtime_unavailable', 'Source analysis is unavailable.');
}

function findAnalyzer(analyzer, names) {
  for (const name of names) {
    if (typeof analyzer?.[name] === 'function') {
      return analyzer[name].bind(analyzer);
    }
  }
  return undefined;
}

function requireApi(runtime) {
  if (!hasApiKey(runtime) || !runtime.client) {
    return failureResult(
      'auth_required',
      'Set SHADERTOY_API_KEY in the server environment before requesting the official Shadertoy API.',
    );
  }
  return undefined;
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

async function withTimeout(operation, timeoutMs) {
  const AbortControllerClass = globalThis.AbortController;
  if (typeof AbortControllerClass !== 'function') {
    return operation(undefined);
  }
  const controller = new AbortControllerClass();
  let timeout;
  let timedOut = false;
  try {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // Catalog synchronization observes this signal before each mutation and
    // returns a structured cancelled result. Waiting for that cleanup avoids
    // the old Promise.race behavior where a timed-out operation kept writing.
    const result = await operation(controller.signal);
    if (timedOut && (!result || result.status !== 'cancelled')) {
      return cancelledResult();
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      return cancelledResult();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function cancelledResult() {
  return {
    status: 'cancelled',
    error: {
      code: 'cancelled',
      message: 'The bounded synchronization step was cancelled before completion.',
      retryable: false,
    },
    resumable: true,
  };
}

function resultFromOperation(result) {
  const payload = result && typeof result === 'object'
    ? boundedMetadata(result)
    : { status: 'ok', result: boundedMetadata(result) };
  const status = typeof payload.status === 'string' ? payload.status : 'ok';
  if (status === 'ok' || status === 'success' || status === 'complete' || status === 'completed' || status === 'partial') {
    return successResult(payload);
  }
  return failureResult(status, safeOperationMessage(status), payload);
}

function safeOperationMessage(status) {
  if (status === 'auth_required') {
    return 'Set SHADERTOY_API_KEY in the server environment before requesting the official Shadertoy API.';
  }
  if (status === 'timeout') {
    return 'The bounded operation timed out.';
  }
  return 'The operation did not complete.';
}

function projectForMcp(project) {
  return sanitizeForMcp(project, {
    maxStringLength: MAX_METADATA_TEXT_CHARS,
    maxArrayItems: MAX_ANALYSIS_ARRAY_ITEMS,
    maxDepth: 12,
    removeSourceFields: true,
    removeLocationFields: true,
  });
}

function attributionFor(project, fallbackId) {
  const author = firstString(project, [
    ['author'],
    ['username'],
    ['user', 'username'],
    ['user', 'name'],
    ['info', 'username'],
  ]) || 'unknown';
  const license = firstValue(project, [
    ['license'],
    ['licenseName'],
    ['info', 'license'],
  ]) || 'unknown';
  const id = firstString(project, [['id'], ['shaderId']]) || fallbackId;
  return {
    author: truncateText(author, 512),
    source_url: SHADER_ID_PATTERN.test(id) ? `https://www.shadertoy.com/view/${id}` : null,
    license: licenseForMcp(license),
    api_attribution: 'Shadertoy API',
  };
}

const LICENSE_RESPONSE_KEYS = new Set([
  'spdx',
  'identifier',
  'name',
  'source',
  'evidence',
  'commercial',
  'adaptation',
  'attribution',
  'shareAlike',
  'review',
  'status',
  'conflicts',
  'licenses',
  'disclaimer',
]);

function licenseForMcp(license) {
  if (!license || typeof license !== 'object' || Array.isArray(license)) {
    return sanitizeForMcp(license, {
      maxStringLength: 1_024,
      maxArrayItems: 20,
      maxObjectKeys: 20,
      maxDepth: 4,
      removeSourceFields: true,
      removeLocationFields: true,
    });
  }
  const selected = {};
  for (const key of LICENSE_RESPONSE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(license, key)) {
      selected[key] = license[key];
    }
  }
  // `source` here is license provenance (for example, "declared-license"),
  // not shader source text. Preserve it so attribution reflects the actual
  // persisted classification while exposing only the explicit license shape.
  return sanitizeForMcp(selected, {
    maxStringLength: 1_024,
    maxArrayItems: 20,
    maxObjectKeys: 20,
    maxDepth: 5,
    removeSourceFields: false,
    removeLocationFields: false,
  });
}

function sourceWindowFor(project, args) {
  const passes = findPasses(project);
  const pass = passes[args.passIndex];
  if (!pass || typeof pass !== 'object') {
    throw new ToolRuntimeError('invalid_pass_index', 'The requested pass index is unavailable.');
  }
  const source = sourceFromPass(pass);
  if (typeof source !== 'string') {
    throw new ToolRuntimeError('source_unavailable', 'The requested pass has no cached source.');
  }
  if (args.sourceOffset > source.length) {
    throw new ToolRuntimeError('invalid_source_offset', 'The requested source offset is beyond the selected pass.');
  }
  const end = Math.min(source.length, args.sourceOffset + args.maxChars);
  return {
    pass_index: args.passIndex,
    source_offset: args.sourceOffset,
    max_chars: args.maxChars,
    total_chars: source.length,
    text: source.slice(args.sourceOffset, end),
    truncated: end < source.length,
  };
}

function findPasses(project) {
  if (Array.isArray(project?.passes)) {
    return project.passes;
  }
  if (Array.isArray(project?.renderpass)) {
    return project.renderpass;
  }
  if (Array.isArray(project?.renderPasses)) {
    return project.renderPasses;
  }
  if (Array.isArray(project?.Shader?.renderpass)) {
    return project.Shader.renderpass;
  }
  return [];
}

function sourceFromPass(pass) {
  for (const key of ['source', 'code', 'src', 'fragment', 'fragmentSource', 'shaderSource']) {
    if (typeof pass[key] === 'string') {
      return pass[key];
    }
  }
  return undefined;
}

function firstString(value, paths) {
  const result = firstValue(value, paths);
  return typeof result === 'string' ? result : undefined;
}

function firstValue(value, paths) {
  for (const segments of paths) {
    let candidate = value;
    for (const segment of segments) {
      candidate = candidate && typeof candidate === 'object' ? candidate[segment] : undefined;
    }
    if (candidate !== undefined && candidate !== null) {
      return candidate;
    }
  }
  return undefined;
}

function boundedMetadata(value) {
  return sanitizeForMcp(value, {
    maxStringLength: MAX_METADATA_TEXT_CHARS,
    maxArrayItems: MAX_ANALYSIS_ARRAY_ITEMS,
    maxObjectKeys: MAX_PROTOCOL_OBJECT_KEYS,
    maxDepth: 12,
    removeSourceFields: true,
    removeLocationFields: true,
  });
}

function boundedAnalysis(value) {
  const report = sanitizeForMcp(value, {
    maxStringLength: 4_096,
    maxArrayItems: MAX_ANALYSIS_ARRAY_ITEMS,
    maxObjectKeys: MAX_PROTOCOL_OBJECT_KEYS,
    maxDepth: 12,
    removeSourceFields: true,
    removeLocationFields: true,
  });
  if (jsonByteLength(report) <= MAX_ANALYSIS_TEXT_CHARS) {
    return report;
  }
  // Do not turn a rich report into a clipped JSON string.  This compact form
  // has stable, machine-readable fields even when an analyzer or upstream
  // test double produced a very large result.
  return compactAnalysisReport(report);
}

function compactAnalysisReport(report) {
  const findings = compactFindings(report?.findings, 20);
  const passes = Array.isArray(report?.passes)
    ? report.passes.slice(0, 8).map((pass) => compactAnalysisPass(pass))
    : [];
  const value = {
    status: boundedAnalysisText(report?.status, 'unavailable', 128),
    target: boundedAnalysisText(report?.target, null, 128),
    targetBaseline: boundedAnalysisText(report?.targetBaseline, null, 128),
    analyzerVersion: finiteNumberOrNull(report?.analyzerVersion),
    projectId: boundedAnalysisText(report?.projectId, null, 128),
    passName: boundedAnalysisText(report?.passName, null, 256),
    sourceBytes: finiteNumberOrNull(report?.sourceBytes),
    costLevel: boundedAnalysisText(report?.costLevel ?? report?.cost?.level, 'unknown', 64),
    cost: compactAnalysisCost(report?.cost, report?.costLevel),
    feedback: Boolean(report?.feedback || report?.graph?.hasFeedback || report?.passGraph?.hasFeedback),
    compiled: report?.compiled === true,
    findings,
    passes,
    graph: compactAnalysisGraph(report?.graph ?? report?.passGraph),
    scan: compactAnalysisScan(report?.scan),
    disclaimer: boundedAnalysisText(report?.disclaimer, null, 1_024),
    truncated: true,
  };
  if (Array.isArray(report?.findings) && report.findings.length > findings.length) {
    value.omitted_findings = report.findings.length - findings.length;
  }
  if (Array.isArray(report?.passes) && report.passes.length > passes.length) {
    value.omitted_passes = report.passes.length - passes.length;
  }
  return value;
}

function compactAnalysisPass(value) {
  return {
    passName: boundedAnalysisText(value?.passName, null, 256),
    status: boundedAnalysisText(value?.status, 'unavailable', 128),
    targetBaseline: boundedAnalysisText(value?.targetBaseline, null, 128),
    sourceBytes: finiteNumberOrNull(value?.sourceBytes),
    costLevel: boundedAnalysisText(value?.costLevel ?? value?.cost?.level, 'unknown', 64),
    cost: compactAnalysisCost(value?.cost, value?.costLevel),
    findings: compactFindings(value?.findings, 4),
  };
}

function compactAnalysisCost(value, fallbackLevel) {
  const cost = value && typeof value === 'object' ? value : {};
  return {
    level: boundedAnalysisText(cost.level ?? fallbackLevel, 'unknown', 64),
    score: finiteNumberOrNull(cost.score),
    rationale: sanitizeForMcp(cost.rationale || {}, {
      maxStringLength: 256,
      maxArrayItems: 8,
      maxObjectKeys: 12,
      maxDepth: 4,
      removeSourceFields: true,
      removeLocationFields: true,
    }),
  };
}

function compactFindings(value, maxItems) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, maxItems).map((finding) => ({
    severity: boundedAnalysisText(finding?.severity, 'info', 32),
    category: boundedAnalysisText(finding?.category, 'unknown', 128),
    code: boundedAnalysisText(finding?.code, 'unknown', 128),
    line: finiteNumberOrNull(finding?.line),
    passName: boundedAnalysisText(finding?.passName, null, 256),
    message: boundedAnalysisText(finding?.message, '', 512),
  }));
}

function compactAnalysisGraph(value) {
  const graph = value && typeof value === 'object' ? value : {};
  return {
    hasFeedback: Boolean(graph.hasFeedback || graph.feedback),
    node_count: Array.isArray(graph.nodes) ? graph.nodes.length : null,
    edge_count: Array.isArray(graph.edges) ? graph.edges.length : null,
    cycle_count: Array.isArray(graph.cycles) ? graph.cycles.length : null,
  };
}

function compactAnalysisScan(value) {
  const scan = value && typeof value === 'object' ? value : {};
  return {
    lineCount: finiteNumberOrNull(scan.lineCount),
    lineIndexBuildSteps: finiteNumberOrNull(scan.lineIndexBuildSteps),
    lineLookups: finiteNumberOrNull(scan.lineLookups),
    lineLookupSteps: finiteNumberOrNull(scan.lineLookupSteps),
  };
}

function boundedAnalysisText(value, fallback, maxLength) {
  return typeof value === 'string' ? truncateText(value, maxLength) : fallback;
}

function finiteNumberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

const SOURCE_FIELD_KEYS = new Set([
  'source',
  'code',
  'src',
  'fragment',
  'fragmentsource',
  'shadersource',
  'sourcecode',
  'glsl',
  'common',
  'commonsource',
  'rawpayload',
  'raw',
  'official',
]);
const LOCATION_LIKE_KEY = /(path|file|directory|url|uri|endpoint|sql|api.?key|token|secret)/i;

function sanitizeForMcp(value, options, depth = 0, seen = new WeakSet()) {
  const {
    maxStringLength,
    maxArrayItems,
    maxObjectKeys = MAX_PROTOCOL_OBJECT_KEYS,
    maxDepth,
    removeSourceFields,
    removeLocationFields,
  } = options;
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return truncateText(value, maxStringLength);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (depth >= maxDepth) {
    return '[Truncated]';
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.slice(0, maxArrayItems).map((item) => sanitizeForMcp(item, options, depth + 1, seen));
    if (value.length > maxArrayItems) {
      output.push({ truncated: true, omitted: value.length - maxArrayItems });
    }
    seen.delete(value);
    return output;
  }
  const output = {};
  let acceptedKeys = 0;
  let omittedKeys = false;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    const item = value[key];
    if ((removeSourceFields && isSourceFieldKey(key)) || (removeLocationFields && LOCATION_LIKE_KEY.test(key))) {
      continue;
    }
    if (typeof item !== 'function' && typeof item !== 'undefined') {
      if (acceptedKeys >= maxObjectKeys) {
        omittedKeys = true;
        break;
      }
      output[key] = sanitizeForMcp(item, options, depth + 1, seen);
      acceptedKeys += 1;
    }
  }
  if (omittedKeys) {
    output.truncated = true;
  }
  seen.delete(value);
  return output;
}

function isSourceFieldKey(key) {
  return SOURCE_FIELD_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function truncateText(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  const marker = '... [truncated]';
  if (maxLength <= marker.length) {
    return marker.slice(0, Math.max(0, maxLength));
  }
  return `${value.slice(0, Math.max(0, maxLength - marker.length))}${marker}`;
}

export function successResult(payload) {
  return mcpToolResult(payload, false);
}

export function failureResult(code, message, details) {
  const error = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return mcpToolResult({ status: code, error }, true);
}

function failureFromError(error) {
  if (error instanceof ToolRuntimeError) {
    return failureResult(error.code || 'runtime_error', error.message);
  }
  return failureResult('operation_failed', 'The operation could not be completed.');
}

function mcpToolResult(payload, isError) {
  const structuredContent = toJsonValue(payload);
  const text = JSON.stringify(structuredContent);
  if (Buffer.byteLength(text, 'utf8') > MAX_TOOL_CONTENT_BYTES) {
    return responseTooLargeToolResult();
  }
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function responseTooLargeToolResult() {
  const structuredContent = {
    status: 'response_too_large',
    error: {
      code: 'response_too_large',
      message: 'The bounded tool response exceeds the protocol content budget.',
    },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

/**
 * SQLite values can include BigInt in newer Node versions.  Convert only at
 * the protocol boundary so JSON-RPC serialization never leaks a stack trace
 * or fails after a successful database operation.
 */
function toJsonValue(value) {
  return sanitizeForMcp(value, {
    maxStringLength: MAX_PROTOCOL_STRING_CHARS,
    maxArrayItems: MAX_PROTOCOL_ARRAY_ITEMS,
    maxObjectKeys: MAX_PROTOCOL_OBJECT_KEYS,
    maxDepth: 12,
    removeSourceFields: false,
    removeLocationFields: false,
  });
}

function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export const TOOL_LIMITS = Object.freeze({
  maxQueryLength: MAX_QUERY_LENGTH,
  maxSourceLength: MAX_SOURCE_LENGTH,
  maxSyncStepLimit: MAX_MCP_SYNC_STEP_LIMIT,
  syncStepTimeoutMs: SYNC_STEP_TIMEOUT_MS,
});
