import {
  ToolInputError,
  ToolRuntimeError,
  failureResult,
  successResult,
} from '../tools.mjs';
import { ANALYSIS_DISCLAIMER } from '../analyzer.mjs';
import { SOURCE_PROVIDER_IDS } from './source-registry.mjs';
import { createSourceRuntime } from './source-runtime.mjs';

const MAX_QUERY_LENGTH = 200;
const MAX_URL_LENGTH = 128 * 1024;
const MAX_PROVIDER_LENGTH = 64;
const MAX_RESOURCE_ID_LENGTH = 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_WINDOW_CHARS = 32_768;
const MAX_OFFSET = 10_000;
const MAX_SYNC_STEP_LIMIT = 10;
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_SYNC_STEP_LIMIT = 3;
const SYNC_STEP_TIMEOUT_MS = 30_000;
const MAX_METADATA_STRING_CHARS = 4_096;
const MAX_METADATA_ARRAY_ITEMS = 100;
const MAX_METADATA_OBJECT_KEYS = 100;
const MAX_METADATA_DEPTH = 10;
const MAX_LICENSE_EVIDENCE_TEXT_CHARS = 1_024;

const TARGETS = Object.freeze(['unknown', 'gles100', 'gles300']);
const RESOURCE_KINDS = Object.freeze(['shader', 'knowledge']);
const AUTHORIZATION_BASES = Object.freeze([
  'user-owned',
  'licensed',
  'author-permission',
  'repository-license',
  'reference-only',
]);

const SOURCE_TOOL_NAMES = Object.freeze([
  'shader_source_registry_status',
  'resolve_shader_source_url',
  'search_shader_sources',
  'get_shader_source_record',
  'import_shader_link',
  'sync_shader_source_step',
  'analyze_shader_source',
]);

const SOURCE_TOOL_NAME_SET = new Set(SOURCE_TOOL_NAMES);

export const SOURCE_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'shader_source_registry_status',
    description: 'Show the fixed shader and learning-source provider matrix, local V2 cache health, and non-crawling limits.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'resolve_shader_source_url',
    description: 'Recognize one strict, allowlisted source URL without fetching it or returning embedded source text.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: MAX_URL_LENGTH },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_shader_sources',
    description: 'Search the local multi-source V2 cache. It never searches a provider website or returns cached source/body text.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH, pattern: '\\S' },
        provider: { type: 'string', enum: SOURCE_PROVIDER_IDS },
        kind: { type: 'string', enum: RESOURCE_KINDS },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: DEFAULT_SEARCH_LIMIT },
        offset: { type: 'integer', minimum: 0, maximum: MAX_OFFSET, default: 0 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_shader_source_record',
    description: 'Get one V2 resource record. Content is omitted unless include_content=true supplies blob_index, content_offset, and max_chars.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: SOURCE_PROVIDER_IDS },
        id: { type: 'string', minLength: 1, maxLength: MAX_RESOURCE_ID_LENGTH },
        include_content: { type: 'boolean', default: false },
        blob_index: { type: 'integer', minimum: 0, maximum: 255 },
        content_offset: { type: 'integer', minimum: 0, maximum: MAX_SOURCE_BYTES },
        max_chars: { type: 'integer', minimum: 1, maximum: MAX_CONTENT_WINDOW_CHARS },
      },
      required: ['provider', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'import_shader_link',
    description: 'Import one allowlisted source link only through its fixed provider policy. The caller must state an auditable authorization basis.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: MAX_URL_LENGTH },
        authorization_basis: { type: 'string', enum: AUTHORIZATION_BASES },
      },
      required: ['url', 'authorization_basis'],
      additionalProperties: false,
    },
  },
  {
    name: 'sync_shader_source_step',
    description: 'Synchronize at most 10 resources for one provider in a 30-second cancellable step.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: SOURCE_PROVIDER_IDS },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SYNC_STEP_LIMIT, default: DEFAULT_SYNC_STEP_LIMIT },
      },
      required: ['provider'],
      additionalProperties: false,
    },
  },
  {
    name: 'analyze_shader_source',
    description: 'Run bounded text-level analysis of supplied shader source for a declared provider and target baseline; it does not compile or run anything.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: SOURCE_PROVIDER_IDS },
        source: { type: 'string', minLength: 1, maxLength: MAX_SOURCE_BYTES },
        target: { type: 'string', enum: TARGETS, default: 'unknown' },
      },
      required: ['provider', 'source'],
      additionalProperties: false,
    },
  },
]);

export const SOURCE_TOOL_LIMITS = Object.freeze({
  maxQueryLength: MAX_QUERY_LENGTH,
  maxUrlLength: MAX_URL_LENGTH,
  maxResourceIdLength: MAX_RESOURCE_ID_LENGTH,
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxContentWindowChars: MAX_CONTENT_WINDOW_CHARS,
  maxSyncStepLimit: MAX_SYNC_STEP_LIMIT,
  syncStepTimeoutMs: SYNC_STEP_TIMEOUT_MS,
});

const SOURCE_REGISTRY_DISCLAIMER =
  'This registry uses fixed provider policies and local cache operations. It is not a general website crawler, does not bypass access controls, and does not treat a platform license as a license for every user work.';

const SOURCE_ANALYSIS_DISCLAIMER =
  `${ANALYSIS_DISCLAIMER} Provider and host findings are conservative text-level indicators only; no NetEase target entry, GLSL compiler, MCDK session, or in-game validation was run.`;

/**
 * Construct the isolated V2 tool registry.  The legacy Shadertoy registry is
 * deliberately untouched so its seven-tool protocol contract remains stable.
 */
export function createSourceToolRegistry(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    throw new TypeError('A source tool runtime is required.');
  }

  return Object.freeze({
    list: () => SOURCE_TOOL_DEFINITIONS,
    has: (name) => SOURCE_TOOL_NAME_SET.has(name),
    async call(name, input = {}) {
      const args = validateSourceToolInput(name, input, runtime);
      try {
        switch (name) {
          case 'shader_source_registry_status':
            return successResult(await sourceRegistryStatus(runtime));
          case 'resolve_shader_source_url':
            return await resolveShaderSourceUrl(runtime, args);
          case 'search_shader_sources':
            return successResult(await searchShaderSources(runtime, args));
          case 'get_shader_source_record':
            return await getShaderSourceRecord(runtime, args);
          case 'import_shader_link':
            return await importShaderLink(runtime, args);
          case 'sync_shader_source_step':
            return await syncShaderSourceStep(runtime, args);
          case 'analyze_shader_source':
            return await analyzeShaderSource(runtime, args);
          default:
            return failureResult('unknown_tool', 'The requested source-registry tool is not available.');
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

/**
 * Validate every public input before a provider, database, URL parser, or
 * analyzer sees it.  Input-contract errors intentionally become JSON-RPC
 * invalid-params errors in SourceMcpStdioServer.
 */
export function validateSourceToolInput(name, input, runtime) {
  if (!SOURCE_TOOL_NAME_SET.has(name)) {
    throw new ToolInputError('Unknown tool name.', { name });
  }
  const value = assertPlainObject(input, 'Tool arguments must be an object.');

  switch (name) {
    case 'shader_source_registry_status':
      assertKnownKeys(value, []);
      return {};
    case 'resolve_shader_source_url':
      assertKnownKeys(value, ['url']);
      return { url: readUrl(value, 'url') };
    case 'search_shader_sources':
      assertKnownKeys(value, ['query', 'provider', 'kind', 'limit', 'offset']);
      return {
        query: readText(value, 'query', { required: true, maxLength: MAX_QUERY_LENGTH }),
        provider: readProvider(value, 'provider', runtime),
        kind: readEnum(value, 'kind', RESOURCE_KINDS),
        limit: readInteger(value, 'limit', { defaultValue: DEFAULT_SEARCH_LIMIT, min: 1, max: 50 }),
        offset: readInteger(value, 'offset', { defaultValue: 0, min: 0, max: MAX_OFFSET }),
      };
    case 'get_shader_source_record':
      return validateGetSourceRecordInput(value, runtime);
    case 'import_shader_link':
      assertKnownKeys(value, ['url', 'authorization_basis']);
      return {
        url: readUrl(value, 'url'),
        authorizationBasis: readEnum(value, 'authorization_basis', AUTHORIZATION_BASES, undefined, true),
      };
    case 'sync_shader_source_step':
      assertKnownKeys(value, ['provider', 'limit']);
      return {
        provider: readProvider(value, 'provider', runtime, true),
        limit: readInteger(value, 'limit', {
          defaultValue: DEFAULT_SYNC_STEP_LIMIT,
          min: 1,
          max: MAX_SYNC_STEP_LIMIT,
        }),
      };
    case 'analyze_shader_source':
      assertKnownKeys(value, ['provider', 'source', 'target']);
      return {
        provider: readProvider(value, 'provider', runtime, true),
        source: readText(value, 'source', {
          required: true,
          trim: false,
          maxLength: MAX_SOURCE_BYTES,
          maxBytes: MAX_SOURCE_BYTES,
        }),
        target: readEnum(value, 'target', TARGETS, 'unknown'),
      };
    default:
      throw new ToolInputError('Unknown tool name.', { name });
  }
}

// A short alias is useful to clients that follow the naming used by the
// original MCP implementation, without coupling the two registries.
export const validateToolInput = validateSourceToolInput;

export async function createRuntime(options = {}) {
  return createSourceRuntime(options);
}

async function sourceRegistryStatus(runtime) {
  const descriptors = await listProviders(runtime.registry);
  const cacheStatus = await callRequired(runtime.store, 'status');
  return {
    status: 'ok',
    providers: descriptors.map(providerDescriptorForMcp),
    // Store.status() intentionally knows its local SQLite path, but an MCP
    // status response must expose only health/counts, never local paths.
    cache: boundedCacheStatus(cacheStatus || {}),
    cache_counts: cacheCounts(cacheStatus || {}),
    disclaimer: SOURCE_REGISTRY_DISCLAIMER,
  };
}

async function resolveShaderSourceUrl(runtime, args) {
  const result = await resolveLink(runtime, args.url);
  const failure = operationFailure(result, { operation: 'resolve' });
  if (failure) {
    return failure;
  }
  const resolved = unwrapResolved(result);
  if (!resolved) {
    return failureResult('unsupported_url', 'The URL does not match a fixed, safe source-provider reference.');
  }
  return successResult({
    status: 'ok',
    source: resolvedSourceForMcp(resolved),
    disclaimer: 'Resolving a link is offline recognition only; no page, source, asset, or remote project was fetched.',
  });
}

async function searchShaderSources(runtime, args) {
  const rows = await callRequired(runtime.store, 'search', args.query, {
    limit: args.limit,
    offset: args.offset,
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.kind ? { kind: args.kind } : {}),
  });
  return {
    status: 'ok',
    query: args.query,
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.kind ? { kind: args.kind } : {}),
    limit: args.limit,
    offset: args.offset,
    results: Array.isArray(rows) ? rows.map(sourceRecordForMcp) : [],
    content_included: false,
  };
}

async function getShaderSourceRecord(runtime, args) {
  const record = await callRequired(runtime.store, 'getResource', { provider: args.provider, id: args.id });
  if (!record) {
    return failureResult('not_found', 'No cached source record exists for this provider and id.', {
      ref: { provider: args.provider, id: args.id },
    });
  }
  const payload = {
    status: 'ok',
    record: sourceRecordForMcp(record),
    content_included: false,
  };
  if (args.includeContent) {
    const content = contentWindowFor(record, args);
    if (content.error) {
      return failureResult(content.error.code, content.error.message, content.error.details);
    }
    payload.content = content.value;
    payload.content_included = true;
  }
  return successResult(payload);
}

async function importShaderLink(runtime, args) {
  const service = requireService(runtime, 'importLink');
  const result = await service.importLink({
    url: args.url,
    authorizationBasis: args.authorizationBasis,
  });
  const failure = operationFailure(result, { operation: 'import' });
  if (failure) {
    return failure;
  }
  const resource = unwrapResource(result);
  const resolved = unwrapResolved(result);
  return successResult({
    status: 'ok',
    ...(resource ? { resource: sourceRecordForMcp(resource) } : {}),
    ...(resolved ? { source: resolvedSourceForMcp(resolved) } : {}),
    authorization_basis: args.authorizationBasis,
    content_included: false,
    disclaimer: 'Imported content remains subject to the recorded provider policy and authorization basis. This response never returns the cached source/body text.',
  });
}

async function syncShaderSourceStep(runtime, args) {
  const service = requireService(runtime, 'syncStep');
  const result = await withTimeout(
    (signal) => service.syncStep({ provider: args.provider, limit: args.limit, signal }),
    SYNC_STEP_TIMEOUT_MS,
  );
  const failure = operationFailure(result, { provider: args.provider, operation: 'sync' });
  if (failure) {
    return failure;
  }
  return successResult({
    status: typeof result?.status === 'string' ? boundedStatus(result.status) : 'ok',
    provider: args.provider,
    limit: args.limit,
    sync: boundedOperation(result),
    disclaimer: 'A sync step is bounded to 10 resources and 30 seconds. It does not enable site-wide crawling.',
  });
}

async function analyzeShaderSource(runtime, args) {
  const analyzer = runtime.analyzer;
  const analyze = findAnalyzer(analyzer, ['analyzeSource']);
  if (!analyze) {
    throw new ToolRuntimeError('runtime_unavailable', 'Source analysis is unavailable.');
  }
  const base = await analyze(args.source, {
    target: args.target,
    passName: `${args.provider} supplied source`,
  });
  const report = boundedAnalysis(base || {});
  const providerFindings = providerHostFindings(args.provider, args.source);
  report.findings = mergeFindings(report.findings, providerFindings);
  report.provider = args.provider;
  report.target = args.target;
  report.compiled = false;
  report.validation = {
    mode: 'bounded-text-static-analysis',
    glsl_compile: 'not_run',
    netease_entry_verification: 'not_run',
    mcdk_validation: 'not_run',
    in_game_validation: 'not_run',
  };
  report.disclaimer = SOURCE_ANALYSIS_DISCLAIMER;
  return successResult({
    status: 'ok',
    provider: args.provider,
    target: args.target,
    analysis: report,
    disclaimer: SOURCE_ANALYSIS_DISCLAIMER,
  });
}

function validateGetSourceRecordInput(value, runtime) {
  assertKnownKeys(value, ['provider', 'id', 'include_content', 'blob_index', 'content_offset', 'max_chars']);
  const result = {
    provider: readProvider(value, 'provider', runtime, true),
    id: readResourceId(value, 'id'),
  };
  const includeContent = Object.prototype.hasOwnProperty.call(value, 'include_content')
    ? value.include_content
    : false;
  if (typeof includeContent !== 'boolean') {
    throw new ToolInputError('include_content must be a boolean.');
  }
  result.includeContent = includeContent;
  const contentKeys = ['blob_index', 'content_offset', 'max_chars'];
  const supplied = contentKeys.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (!includeContent && supplied.length) {
    throw new ToolInputError('Content window options require include_content=true.');
  }
  if (!includeContent) {
    return result;
  }
  if (supplied.length !== contentKeys.length) {
    throw new ToolInputError('include_content=true requires blob_index, content_offset, and max_chars.');
  }
  result.blobIndex = readInteger(value, 'blob_index', { defaultValue: undefined, min: 0, max: 255 });
  result.contentOffset = readInteger(value, 'content_offset', { defaultValue: undefined, min: 0, max: MAX_SOURCE_BYTES });
  result.maxChars = readInteger(value, 'max_chars', {
    defaultValue: undefined,
    min: 1,
    max: MAX_CONTENT_WINDOW_CHARS,
  });
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

function readUrl(value, key) {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new ToolInputError(`${key} is required.`);
  }
  const url = readText(value, key, { required: true, trim: false, maxLength: MAX_URL_LENGTH, maxBytes: MAX_URL_LENGTH });
  if (url !== url.trim() || /[\u0000-\u001f\u007f]/.test(url)) {
    throw new ToolInputError(`${key} must be a non-whitespace URL string.`);
  }
  return url;
}

function readResourceId(value, key) {
  const id = readText(value, key, { required: true, trim: false, maxLength: MAX_RESOURCE_ID_LENGTH, maxBytes: MAX_RESOURCE_ID_LENGTH });
  if (id !== id.trim() || /[\u0000-\u001f\u007f\\]/.test(id)) {
    throw new ToolInputError(`${key} contains unsupported characters.`);
  }
  return id;
}

function readProvider(value, key, runtime, required = false) {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    if (required) {
      throw new ToolInputError(`${key} is required.`);
    }
    return undefined;
  }
  const provider = readText(value, key, { required: true, maxLength: MAX_PROVIDER_LENGTH });
  const choices = providerIds(runtime);
  if (!choices.includes(provider)) {
    throw new ToolInputError(`${key} must be one of: ${choices.join(', ')}.`);
  }
  return provider;
}

function readEnum(value, key, choices, defaultValue, required = false) {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    if (required) {
      throw new ToolInputError(`${key} is required.`);
    }
    return defaultValue;
  }
  if (typeof value[key] !== 'string' || !choices.includes(value[key])) {
    throw new ToolInputError(`${key} must be one of: ${choices.join(', ')}.`);
  }
  return value[key];
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

async function listProviders(registry) {
  if (!registry || typeof registry.list !== 'function') {
    throw new ToolRuntimeError('runtime_unavailable', 'The source provider registry is unavailable.');
  }
  const descriptors = await registry.list();
  return Array.isArray(descriptors) ? descriptors : [];
}

function providerIds(runtime) {
  const descriptors = runtime?.registry && typeof runtime.registry.list === 'function'
    ? runtime.registry.list()
    : [];
  if (Array.isArray(descriptors)) {
    const ids = descriptors
      .map((descriptor) => descriptor?.id)
      .filter((id) => typeof id === 'string' && id.length && id.length <= MAX_PROVIDER_LENGTH);
    if (ids.length) {
      return [...new Set(ids)];
    }
  }
  return SOURCE_PROVIDER_IDS.slice();
}

async function resolveLink(runtime, url) {
  if (typeof runtime?.service?.resolveLink === 'function') {
    return runtime.service.resolveLink(url);
  }
  if (typeof runtime?.registry?.resolveUrl === 'function') {
    return runtime.registry.resolveUrl(url);
  }
  throw new ToolRuntimeError('runtime_unavailable', 'Source URL resolution is unavailable.');
}

function requireService(runtime, method) {
  if (!runtime?.service || typeof runtime.service[method] !== 'function') {
    throw new ToolRuntimeError('runtime_unavailable', `The required ${method} provider operation is unavailable.`);
  }
  return runtime.service;
}

async function callRequired(target, method, ...args) {
  if (!target || typeof target[method] !== 'function') {
    throw new ToolRuntimeError('runtime_unavailable', `The required local ${method} operation is unavailable.`);
  }
  return target[method](...args);
}

function unwrapResolved(value) {
  if (isResolvedSource(value)) {
    return value;
  }
  if (isResolvedSource(value?.resolved)) {
    return value.resolved;
  }
  if (isResolvedSource(value?.source)) {
    return value.source;
  }
  return null;
}

function unwrapResource(value) {
  if (isResource(value?.resource)) {
    return value.resource;
  }
  if (isResource(value?.record)) {
    return value.record;
  }
  // Provider-service results also carry a top-level ref for the operation.
  // Inspect nested resource envelopes first so an operation is never mistaken
  // for the cached resource it created.
  if (isResource(value)) {
    return value;
  }
  return null;
}

function isResolvedSource(value) {
  return Boolean(value)
    && typeof value === 'object'
    && value.ref
    && typeof value.ref.provider === 'string'
    && typeof value.ref.id === 'string'
    && typeof value.canonicalUrl === 'string';
}

function isResource(value) {
  return Boolean(value)
    && typeof value === 'object'
    && value.ref
    && typeof value.ref.provider === 'string'
    && typeof value.ref.id === 'string'
    && RESOURCE_KINDS.includes(value.kind)
    && typeof value.title === 'string';
}

function operationFailure(value, defaults = {}) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const error = value.error;
  const nonSuccessStatus = typeof value.status === 'string'
    && !['ok', 'success', 'complete', 'completed', 'partial'].includes(value.status);
  if (!error && !nonSuccessStatus) {
    return null;
  }
  const code = safeErrorCode(error?.code || value.status || 'operation_failed');
  const details = {
    ...(safeProvider(error?.provider || value.provider || defaults.provider) ? { provider: error?.provider || value.provider || defaults.provider } : {}),
    ...(safeOperation(error?.operation || defaults.operation) ? { operation: error?.operation || defaults.operation } : {}),
    ...(typeof error?.retryable === 'boolean' ? { retryable: error.retryable } : {}),
    ...(typeof error?.resumable === 'boolean' ? { resumable: error.resumable } : {}),
    ...(safeRef(error?.ref || value.ref) ? { ref: safeRef(error?.ref || value.ref) } : {}),
  };
  return failureResult(code, safeErrorMessage(code), Object.keys(details).length ? details : undefined);
}

function failureFromError(error) {
  if (error instanceof ToolRuntimeError) {
    return failureResult(safeErrorCode(error.code || 'runtime_error'), safeErrorMessage(error.code || 'runtime_error'));
  }
  const code = safeErrorCode(error?.code || 'operation_failed');
  return failureResult(code, safeErrorMessage(code));
}

function safeErrorCode(value) {
  const code = typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : 'operation_failed';
  return code;
}

function safeErrorMessage(code) {
  const messages = {
    unsupported_url: 'The URL does not match a fixed, safe source-provider reference.',
    invalid_ref: 'The provider reference is invalid.',
    operation_not_supported: 'This provider does not support that operation.',
    license_review_required: 'The provider requires a human license review before this content can be reused.',
    license_conflict: 'Conflicting license evidence requires human review.',
    content_policy_blocked: 'The provider content policy does not allow this content to be cached or returned.',
    not_found: 'The requested source record was not found.',
    upstream_timeout: 'The bounded upstream operation timed out.',
    rate_limited: 'The provider rate-limited the bounded operation.',
    cancelled: 'The bounded operation was cancelled before completion.',
    operation_budget_exhausted: 'The bounded operation reached its resource budget.',
    runtime_unavailable: 'The local source-registry runtime is unavailable.',
  };
  return messages[code] || 'The source-provider operation could not be completed.';
}

function safeProvider(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PROVIDER_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeOperation(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

function safeRef(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (!safeProvider(value.provider) || typeof value.id !== 'string' || !value.id.length || value.id.length > MAX_RESOURCE_ID_LENGTH) {
    return null;
  }
  return { provider: value.provider, id: value.id };
}

function providerDescriptorForMcp(descriptor) {
  return {
    id: boundedText(descriptor?.id, 64),
    displayName: boundedText(descriptor?.displayName, 256),
    kind: boundedText(descriptor?.kind, 64),
    homepage: boundedText(descriptor?.homepage, MAX_METADATA_STRING_CHARS),
    accessMode: boundedText(descriptor?.accessMode, 128),
    capabilities: boundedStringArray(descriptor?.capabilities, 64, 128),
    licensePolicy: boundedMetadata(descriptor?.licensePolicy || {}),
    networkPolicy: boundedMetadata(descriptor?.networkPolicy || {}),
    notes: boundedStringArray(descriptor?.notes, 32, 1_024),
  };
}

function resolvedSourceForMcp(resolved) {
  return {
    ref: safeRef(resolved?.ref),
    kind: boundedText(resolved?.kind, 64),
    canonicalUrl: boundedText(redactInlineUrl(resolved?.canonicalUrl), MAX_METADATA_STRING_CHARS),
    accessMode: boundedText(resolved?.accessMode, 128),
    licensePolicy: boundedMetadata(resolved?.licensePolicy || {}),
    metadata: boundedMetadata(resolved?.metadata || {}),
  };
}

function sourceRecordForMcp(record) {
  const hasBlobCollection = Array.isArray(record?.blobs);
  const blobs = hasBlobCollection ? record.blobs : [];
  const storedBodyBytes = Number.isSafeInteger(record?.bodyBytes) && record.bodyBytes >= 0
    ? record.bodyBytes
    : null;
  const storedBlobCount = Number.isSafeInteger(record?.blobCount) && record.blobCount >= 0
    ? record.blobCount
    : null;
  return {
    ref: safeRef(record?.ref),
    kind: boundedText(record?.kind, 64),
    title: boundedText(record?.title, MAX_METADATA_STRING_CHARS),
    author: boundedText(record?.author, MAX_METADATA_STRING_CHARS),
    description: boundedText(record?.description, MAX_METADATA_STRING_CHARS),
    tags: boundedStringArray(record?.tags, 100, 256),
    language: boundedText(record?.language, 128),
    canonicalUrl: boundedText(redactInlineUrl(record?.canonicalUrl), MAX_METADATA_STRING_CHARS),
    rights: boundedRights(record?.rights || {}),
    provenance: boundedMetadata(record?.provenance || {}),
    authorization: boundedMetadata(record?.authorization || {}),
    contentPolicy: boundedMetadata(record?.contentPolicy || {}),
    metadata: boundedMetadata(record?.metadata || {}),
    // SourceStore.search() intentionally omits blobs. Returning zero there
    // would incorrectly claim that a full-source record has no content.
    blob_count: hasBlobCollection ? blobs.length : storedBlobCount,
    content_available: hasBlobCollection ? blobs.length > 0 : storedBodyBytes === null ? null : storedBodyBytes > 0,
  };
}

function contentWindowFor(record, args) {
  const blobs = Array.isArray(record?.blobs) ? record.blobs : [];
  const blob = blobs[args.blobIndex];
  if (!blob || typeof blob !== 'object') {
    return { error: { code: 'invalid_blob_index', message: 'The requested blob index is unavailable.' } };
  }
  const body = stringContent(blob.body);
  if (body === null) {
    return { error: { code: 'content_unavailable', message: 'The requested blob is not UTF-8 text content.' } };
  }
  if (args.contentOffset > body.length) {
    return { error: { code: 'invalid_content_offset', message: 'The requested content offset is beyond the selected blob.' } };
  }
  const end = Math.min(body.length, args.contentOffset + args.maxChars);
  return {
    value: {
      blob_index: args.blobIndex,
      role: boundedText(blob.role, 256),
      mime_type: boundedText(blob.mimeType || blob.mime_type, 256),
      content_offset: args.contentOffset,
      max_chars: args.maxChars,
      total_chars: body.length,
      text: body.slice(args.contentOffset, end),
      truncated: end < body.length,
    },
  };
}

function stringContent(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(value);
    } catch {
      return null;
    }
  }
  return null;
}

function cacheCounts(status) {
  const outer = status && typeof status === 'object' ? status : {};
  const source = outer.counts && typeof outer.counts === 'object' ? outer.counts : outer;
  const read = (...names) => {
    for (const name of names) {
      if (Number.isSafeInteger(source[name]) && source[name] >= 0) {
        return source[name];
      }
    }
    return 0;
  };
  return {
    resources: read('resources', 'resourceCount', 'resource_count'),
    shaders: read('shaders', 'shaderCount', 'shader_count'),
    knowledge: read('knowledge', 'knowledgeCount', 'knowledge_count'),
    blobs: read('blobs', 'blobCount', 'blob_count'),
  };
}

function boundedOperation(value) {
  return boundedValue(value, {
    maxStringLength: MAX_METADATA_STRING_CHARS,
    maxArrayItems: MAX_METADATA_ARRAY_ITEMS,
    maxObjectKeys: MAX_METADATA_OBJECT_KEYS,
    maxDepth: MAX_METADATA_DEPTH,
    removeContent: true,
    removeLocations: false,
  });
}

function boundedCacheStatus(value) {
  return boundedValue(value, {
    maxStringLength: MAX_METADATA_STRING_CHARS,
    maxArrayItems: MAX_METADATA_ARRAY_ITEMS,
    maxObjectKeys: MAX_METADATA_OBJECT_KEYS,
    maxDepth: MAX_METADATA_DEPTH,
    removeContent: true,
    removeLocations: true,
  });
}

function boundedAnalysis(value) {
  return boundedValue(value, {
    maxStringLength: MAX_METADATA_STRING_CHARS,
    maxArrayItems: MAX_METADATA_ARRAY_ITEMS,
    maxObjectKeys: MAX_METADATA_OBJECT_KEYS,
    maxDepth: MAX_METADATA_DEPTH,
    removeContent: true,
    removeLocations: true,
    preserveFindingCode: true,
  }) || {};
}

function boundedMetadata(value) {
  return boundedValue(value, {
    maxStringLength: MAX_METADATA_STRING_CHARS,
    maxArrayItems: MAX_METADATA_ARRAY_ITEMS,
    maxObjectKeys: MAX_METADATA_OBJECT_KEYS,
    maxDepth: MAX_METADATA_DEPTH,
    removeContent: true,
    removeLocations: false,
  });
}

function boundedRights(value) {
  return boundedValue(value, {
    maxStringLength: MAX_METADATA_STRING_CHARS,
    maxArrayItems: MAX_METADATA_ARRAY_ITEMS,
    maxObjectKeys: MAX_METADATA_OBJECT_KEYS,
    maxDepth: MAX_METADATA_DEPTH,
    removeContent: true,
    removeLocations: false,
    preserveLicenseEvidenceText: true,
  });
}

function boundedValue(value, options, depth = 0, seen = new WeakSet(), pathSegments = []) {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return boundedText(redactInlineUrl(value), options.maxStringLength);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (!value || typeof value !== 'object') {
    return value === undefined ? undefined : String(value);
  }
  if (depth >= options.maxDepth) {
    return '[Truncated]';
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.slice(0, options.maxArrayItems)
      .map((item) => boundedValue(item, options, depth + 1, seen, pathSegments));
    if (value.length > options.maxArrayItems) {
      output.push({ truncated: true, omitted: value.length - options.maxArrayItems });
    }
    seen.delete(value);
    return output;
  }
  const output = {};
  let accepted = 0;
  for (const [key, item] of Object.entries(value)) {
    const preserveLicenseEvidenceText = options.preserveLicenseEvidenceText
      && key === 'text'
      && pathSegments.length === 1
      && pathSegments[0] === 'evidence'
      && typeof item === 'string';
    const preserveFindingCode = options.preserveFindingCode
      && key === 'code'
      && pathSegments.at(-1) === 'findings'
      && typeof item === 'string';
    const preserveStructuredField = preserveLicenseEvidenceText || preserveFindingCode;
    if (((options.removeContent && contentLikeKey(key) && !preserveStructuredField)
        || (options.removeLocations && locationLikeKey(key)))) {
      continue;
    }
    if (typeof item === 'function' || item === undefined) {
      continue;
    }
    if (accepted >= options.maxObjectKeys) {
      output.truncated = true;
      break;
    }
    output[key] = preserveLicenseEvidenceText
      ? boundedText(redactInlineUrl(item), MAX_LICENSE_EVIDENCE_TEXT_CHARS)
      : boundedValue(item, options, depth + 1, seen, pathSegments.concat(key));
    accepted += 1;
  }
  seen.delete(value);
  return output;
}

function contentLikeKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return new Set([
    'source', 'inlinesource', 'inlinesoundsource', 'code', 'body', 'content', 'text', 'blob', 'blobs', 'chunks',
    'fragment', 'fragmentsource', 'vertex', 'vertexsource', 'shadersource', 'sourcecode',
    'glsl', 'rawpayload', 'raw', 'renderpasses',
  ]).has(normalized);
}

/**
 * twigl can carry user code in a share URL. Returning that raw canonical URL
 * would silently bypass the explicit bounded-content window contract, so
 * redact only the known inline-content query values while retaining an
 * attributable, recognisable reference shape.
 */
function redactInlineUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) {
    return value;
  }
  try {
    const url = new URL(value);
    let redacted = false;
    for (const key of ['source', 'soundsource']) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, '[redacted]');
        redacted = true;
      }
    }
    return redacted ? url.toString() : value;
  } catch {
    return value;
  }
}

function locationLikeKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return new Set([
    'path', 'filepath', 'sourcepath', 'localpath', 'databasepath',
    'file', 'filename', 'directory', 'dir', 'endpoint',
    'apikey', 'accesstoken', 'token', 'secret', 'clientsecret', 'password',
  ]).has(normalized);
}

function boundedText(value, maxLength) {
  if (typeof value !== 'string') {
    return value == null ? null : String(value).slice(0, maxLength);
  }
  if (value.length <= maxLength) {
    return value;
  }
  const marker = '... [truncated]';
  return maxLength <= marker.length ? marker.slice(0, Math.max(0, maxLength)) : `${value.slice(0, maxLength - marker.length)}${marker}`;
}

function boundedStringArray(value, maxItems, maxChars) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, maxItems)
    .filter((item) => typeof item === 'string')
    .map((item) => boundedText(item, maxChars));
}

function findAnalyzer(analyzer, names) {
  for (const name of names) {
    if (typeof analyzer?.[name] === 'function') {
      return analyzer[name].bind(analyzer);
    }
  }
  return undefined;
}

function mergeFindings(existing, extra) {
  const before = Array.isArray(existing) ? existing.slice(0, MAX_METADATA_ARRAY_ITEMS - extra.length) : [];
  return [...before, ...extra].slice(0, MAX_METADATA_ARRAY_ITEMS);
}

function providerHostFindings(provider, source) {
  const findings = [];
  const add = (code, message, severity = 'warning') => {
    findings.push({ severity, category: 'provider_host', code, line: 1, message });
  };
  const has = (pattern) => pattern.test(source);
  switch (provider) {
    case 'shadertoy':
      if (has(/\bi(?:Resolution|Time|TimeDelta|Frame|Mouse|Date|Channel[0-3])\b/)) {
        add('shadertoy_host_uniforms', 'Shadertoy host uniforms or channels were found; map each required input to a verified NetEase target interface.');
      }
      break;
    case 'isf':
      if (has(/\b(?:ISFVSN|RENDERSIZE|TIMEDELTA|PASSINDEX|IMG_(?:PIXEL|NORM_PIXEL|SIZE))\b|\bPERSISTENT\b/)) {
        add('isf_host_contract', 'ISF metadata, host variables, sampling helpers, or persistent passes were found; a compatible host contract and pass route are required.');
      }
      break;
    case 'twigl':
      if (has(/\b(?:backbuffer|sound|resolution|time|frame)\b/i)) {
        add('twigl_host_contract', 'twigl-style host inputs may be present; verify time, resolution, frame, audio, and backbuffer semantics before porting.');
      }
      break;
    case 'shaderfrog':
      if (has(/\b(?:attribute|varying|modelViewMatrix|projectionMatrix|normalMatrix|FrogMaterial)\b/)) {
        add('shaderfrog_material_contract', 'ShaderFrog/Three.js material or vertex-interface symbols were found; the material graph and host attributes need manual remapping.');
      }
      break;
    case 'godot-shaders':
      if (has(/\bshader_type\b|\brender_mode\b|\b(?:SCREEN_TEXTURE|DEPTH_TEXTURE|FRAGCOORD|VERTEX|NORMAL|LIGHT)\b/)) {
        add('godot_host_contract', 'Godot shader language or engine built-ins were found; shader type, render mode, and host inputs require a manual dialect and material-route conversion.');
      }
      break;
    case 'book-of-shaders':
    case 'webgl-fundamentals':
      add('knowledge_provider_source', 'This provider is primarily a learning/reference source. Supplied code still needs independent provenance and target-interface review.');
      break;
    default:
      break;
  }
  if (has(/^\s*#version\s+\d+/m)) {
    add('declared_glsl_dialect', 'A GLSL version directive was found. Confirm that the verified target accepts the declared dialect and stage syntax.', 'info');
  }
  return findings;
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
      retryable: false,
      resumable: true,
    },
  };
}

function boundedStatus(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'ok';
}
