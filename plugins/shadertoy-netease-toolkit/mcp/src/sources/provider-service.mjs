import { BoundedHttpError, createBoundedHttpClient } from './bounded-http.mjs';
import { ProviderSyncLeaseError } from './source-store.mjs';
import {
  BOOK_OF_SHADERS_TOPICS,
  extractGodotPageMetadata,
  getGodotSourcePolicy,
  normalizeBookOfShadersTopic,
  normalizeGodotResource,
  normalizeIsfResource,
  normalizeLinkOnlyResource,
  normalizeTwiglResource,
  normalizeWebglLesson,
} from './normalizers.mjs';

const MAX_STEP_LIMIT = 10;
const DEFAULT_STEP_LIMIT = 3;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const GITHUB_API_ORIGIN = 'https://api.github.com';
const TWIGL_SNAPSHOT_ORIGIN = 'https://twigl-f67a0.firebaseio.com';
const GODOT_ORIGIN = 'https://godotshaders.com';
const REPOSITORIES = Object.freeze({
  isf: 'Vidvox/ISF-Files',
  'webgl-fundamentals': 'gfxfundamentals/webgl-fundamentals',
});
const SAFE_ERROR_MESSAGES = Object.freeze({
  cancelled: 'The provider operation was cancelled.',
  content_policy_blocked: 'The provider content policy blocks this operation.',
  invalid_limit: 'The sync limit must be an integer from 1 through 10.',
  invalid_ref: 'The source link is not a recognized fixed provider reference.',
  license_conflict: 'Conflicting license evidence requires human review.',
  license_review_required: 'A human license review is required before source can be cached.',
  not_found: 'The requested provider resource was not found.',
  operation_not_supported: 'This provider does not support that operation.',
  response_too_large: 'The provider response exceeded the 2 MiB limit.',
  sync_in_progress: 'Another maintenance step is already in progress for this provider.',
  store_error: 'The local source cache could not save the resource.',
  unsupported_url: 'The URL is not supported by this fixed provider policy.',
  upstream_schema_changed: 'The upstream provider response did not match the expected schema.',
  upstream_timeout: 'The bounded upstream operation timed out.',
  upstream_unavailable: 'The upstream provider request failed.',
  rate_limited: 'The upstream provider rate-limited this operation.',
});

export class ProviderServiceError extends Error {
  constructor(code, options = {}) {
    super(SAFE_ERROR_MESSAGES[code] || SAFE_ERROR_MESSAGES.upstream_unavailable);
    this.name = 'ProviderServiceError';
    this.code = Object.prototype.hasOwnProperty.call(SAFE_ERROR_MESSAGES, code) ? code : 'upstream_unavailable';
    this.provider = typeof options.provider === 'string' ? options.provider : null;
    this.operation = typeof options.operation === 'string' ? options.operation : null;
    this.ref = options.ref && typeof options.ref === 'object' ? options.ref : null;
    this.retryable = Boolean(options.retryable);
    this.resumable = Boolean(options.resumable);
    this.httpStatus = Number.isInteger(options.httpStatus) ? options.httpStatus : null;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.operation ? { operation: this.operation } : {}),
      ...(this.ref ? { ref: this.ref } : {}),
      retryable: this.retryable,
      resumable: this.resumable,
      ...(this.httpStatus !== null ? { httpStatus: this.httpStatus } : {}),
    };
  }
}

function errorResult(error, context = {}) {
  const normal = asProviderError(error, context);
  return {
    status: normal.code === 'cancelled' ? 'cancelled' : 'error',
    provider: normal.provider || context.provider || null,
    operation: normal.operation || context.operation || null,
    ...(normal.ref ? { ref: normal.ref } : {}),
    error: normal.toJSON(),
  };
}

function asProviderError(error, context = {}) {
  if (error instanceof ProviderServiceError) {
    return error;
  }
  if (error instanceof ProviderSyncLeaseError) {
    return new ProviderServiceError('sync_in_progress', {
      ...context,
      retryable: true,
      resumable: true,
    });
  }
  if (error instanceof BoundedHttpError) {
    let code = error.code;
    if (code === 'http_error') {
      if (error.status === 404) code = 'not_found';
      else if (error.status === 429) code = 'rate_limited';
      else code = 'upstream_unavailable';
    } else if (code === 'network_error' || code === 'fetch_unavailable' || code === 'invalid_response' || code === 'invalid_json' || code === 'redirect_blocked') {
      code = code === 'invalid_json' || code === 'invalid_response' ? 'upstream_schema_changed' : 'upstream_unavailable';
    }
    return new ProviderServiceError(code, {
      ...context,
      retryable: error.retryable,
      // A bounded sync step never advances the cursor until a resource and
      // its state have both been persisted. Retryable upstream faults and a
      // caller cancellation can therefore resume that same cursor; one-shot
      // imports intentionally remain non-resumable.
      resumable: context.operation === 'sync' && (error.retryable || error.code === 'cancelled'),
      httpStatus: error.status,
    });
  }
  return new ProviderServiceError('upstream_unavailable', context);
}

function throwIfAborted(signal, context) {
  if (signal?.aborted) {
    throw new ProviderServiceError('cancelled', { ...context, retryable: false, resumable: true });
  }
}

function isSafeSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

function isSafeRepositoryPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !value.includes('\\')
    && !value.startsWith('/')
    && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function encodeRepositoryPath(path) {
  if (!isSafeRepositoryPath(path)) {
    throw new ProviderServiceError('upstream_schema_changed');
  }
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function githubApiUrl(repository, suffix, query = undefined) {
  const url = new URL(`/repos/${repository}/${suffix}`, GITHUB_API_ORIGIN);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function isFixedGithubUrl(value, repository) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.port || url.username || url.password) {
      return false;
    }
    const prefix = `/repos/${repository}/`;
    if (!url.pathname.startsWith(prefix)) return false;
    const suffix = url.pathname.slice(prefix.length);
    if (suffix === 'commits/master') return !url.search;
    if (/^git\/trees\/[a-f0-9]{40}$/i.test(suffix)) return url.search === '?recursive=1';
    if (/^contents\/[A-Za-z0-9%._~!$&'()*+,;=:@/-]+$/.test(suffix)) {
      return /^\?ref=[a-f0-9]{40}$/i.test(url.search);
    }
    return false;
  } catch {
    return false;
  }
}

function isFixedTwiglSnapshotUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'twigl-f67a0.firebaseio.com'
      && !url.port
      && !url.username
      && !url.password
      && /^\/snapshot\/[A-Za-z0-9_-]{1,128}\.json$/.test(url.pathname)
      && !url.search;
  } catch {
    return false;
  }
}

function isFixedGodotUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'godotshaders.com' || url.port || url.username || url.password) {
      return false;
    }
    return /^\/shader\/[a-z0-9]+(?:[-_][a-z0-9]+)*\/$/.test(url.pathname) && !url.search
      || /^\/wp-json\/shader_data\/shader\/\d+$/.test(url.pathname) && !url.search;
  } catch {
    return false;
  }
}

function ensureRegistry(registry) {
  if (!registry || typeof registry.resolveUrl !== 'function' || typeof registry.get !== 'function') {
    throw new TypeError('A source registry with resolveUrl and get is required.');
  }
  return registry;
}

function ensureStore(store) {
  if (!store
    || typeof store.upsertResource !== 'function'
    || typeof store.getSyncState !== 'function'
    || typeof store.setSyncState !== 'function'
    || typeof store.claimProviderSyncRun !== 'function'
    || typeof store.releaseProviderSyncRun !== 'function'
    || typeof store.heartbeatProviderSyncRun !== 'function'
    || typeof store.upsertResourceForProviderSync !== 'function'
    || typeof store.setSyncStateForProviderSync !== 'function'
    || typeof store.completeProviderSync !== 'function') {
    throw new TypeError('A source store with resource, provider-sync lease, and complete-provider-sync methods is required.');
  }
  return store;
}

function resolve(registry, url, operation) {
  let resolved;
  try {
    resolved = registry.resolveUrl(url);
  } catch {
    resolved = null;
  }
  if (!resolved || !resolved.ref || typeof resolved.ref.provider !== 'string' || typeof resolved.ref.id !== 'string') {
    throw new ProviderServiceError('invalid_ref', { operation });
  }
  return resolved;
}

function normaliseLimit(value) {
  if (value === undefined || value === null) return DEFAULT_STEP_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_STEP_LIMIT) {
    throw new ProviderServiceError('invalid_limit', { operation: 'sync' });
  }
  return value;
}

function parseCursor(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function untrustedError(error, context) {
  if (error instanceof ProviderServiceError || error instanceof ProviderSyncLeaseError || error instanceof BoundedHttpError) return error;
  return new ProviderServiceError('store_error', context);
}

async function persistResource(store, record, context) {
  try {
    await store.upsertResource(record);
    if (typeof store.getResource === 'function') {
      return await store.getResource(record.ref);
    }
    return record;
  } catch (error) {
    throw untrustedError(error, context);
  }
}

async function claimProviderSyncRun(store, provider, context) {
  try {
    const claim = await store.claimProviderSyncRun(provider);
    if (!claim?.acquired) {
      throw new ProviderSyncLeaseError();
    }
    if (typeof claim.runToken !== 'string') {
      throw new Error('Provider sync lease claim did not return a run token.');
    }
    return claim.runToken;
  } catch (error) {
    throw resumableSyncStoreError(error, context);
  }
}

async function releaseProviderSyncRun(store, provider, runToken, context) {
  try {
    const released = await store.releaseProviderSyncRun(provider, runToken);
    if (released !== true) {
      throw new ProviderSyncLeaseError();
    }
    return true;
  } catch (error) {
    throw resumableSyncStoreError(error, context);
  }
}

async function heartbeatProviderSyncRun(store, provider, runToken, context) {
  try {
    return await store.heartbeatProviderSyncRun(provider, runToken);
  } catch (error) {
    throw resumableSyncStoreError(error, context);
  }
}

async function withSyncHeartbeat(store, provider, runToken, context, operation) {
  await heartbeatProviderSyncRun(store, provider, runToken, context);
  const result = await operation();
  await heartbeatProviderSyncRun(store, provider, runToken, context);
  return result;
}

async function persistSyncResource(store, provider, runToken, revision, record, context) {
  try {
    return await store.upsertResourceForProviderSync(provider, runToken, revision, record);
  } catch (error) {
    throw resumableSyncStoreError(error, context);
  }
}

async function persistSyncState(store, provider, runToken, state, context) {
  try {
    return await store.setSyncStateForProviderSync(provider, runToken, state);
  } catch (error) {
    throw resumableSyncStoreError(error, context);
  }
}

function resumableSyncStoreError(error, context) {
  const normal = untrustedError(error, context);
  if (normal instanceof ProviderServiceError && normal.code === 'store_error') {
    // A sync advances its persisted cursor only after its resource is durable.
    // Retrying can therefore overwrite an already-written resource safely or
    // resume from the previous cursor after a state-write failure.
    return new ProviderServiceError('store_error', { ...context, resumable: true });
  }
  return normal;
}

async function completeProviderSync(store, provider, runToken, state, eligibleResourceIds, context, reconciliationScope = null) {
  try {
    return await store.completeProviderSync(provider, runToken, state, eligibleResourceIds, reconciliationScope);
  } catch (error) {
    const normal = untrustedError(error, context);
    if (normal instanceof ProviderServiceError && normal.code === 'store_error') {
      // The complete-state transaction rolls back resource cleanup and state
      // together, so the same bounded sync can safely retry its cursor.
      throw new ProviderServiceError('store_error', { ...context, resumable: true });
    }
    throw normal;
  }
}

async function readState(store, provider, context) {
  try {
    return await store.getSyncState(provider);
  } catch (error) {
    throw resumableSyncStoreError(error, context);
  }
}

function githubText(payload) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'file' || payload.encoding !== 'base64' || typeof payload.content !== 'string') {
    throw new ProviderServiceError('upstream_schema_changed');
  }
  const compact = payload.content.replace(/\s/g, '');
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new ProviderServiceError('upstream_schema_changed');
  }
  const bytes = Buffer.from(compact, 'base64');
  if (!bytes.byteLength || bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new ProviderServiceError('response_too_large', { retryable: false });
  }
  return bytes.toString('utf8');
}

function githubCanonicalUrl(repository, revision, path) {
  return `https://github.com/${repository}/blob/${revision}/${encodeRepositoryPath(path)}`;
}

async function githubCommit(http, repository, signal, provider, headers = {}) {
  const payload = await http.get(githubApiUrl(repository, 'commits/master'), {
    responseType: 'json',
    signal,
    headers,
    allow: (url) => isFixedGithubUrl(url, repository),
  });
  if (!isSafeSha(payload?.sha)) {
    throw new ProviderServiceError('upstream_schema_changed', { provider, operation: 'sync', resumable: true });
  }
  return payload.sha;
}

async function githubTree(http, repository, revision, signal, provider, headers = {}) {
  const payload = await http.get(githubApiUrl(repository, `git/trees/${revision}`, { recursive: '1' }), {
    responseType: 'json',
    signal,
    headers,
    allow: (url) => isFixedGithubUrl(url, repository),
  });
  if (!payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || payload.truncated !== false
    || !Array.isArray(payload.tree)
    || payload.tree.length === 0
    || !payload.tree.every(isSafeGithubTreeEntry)) {
    throw new ProviderServiceError('upstream_schema_changed', { provider, operation: 'sync', resumable: true });
  }
  return payload.tree;
}

function isSafeGithubTreeEntry(entry) {
  return Boolean(entry)
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && ['blob', 'tree', 'commit'].includes(entry.type)
    && typeof entry.path === 'string'
    && isSafeRepositoryPath(entry.path)
    && isSafeSha(entry.sha);
}

async function githubFile(http, repository, revision, path, signal, provider, headers = {}) {
  const encodedPath = encodeRepositoryPath(path);
  const payload = await http.get(githubApiUrl(repository, `contents/${encodedPath}`, { ref: revision }), {
    responseType: 'json',
    signal,
    headers,
    allow: (url) => isFixedGithubUrl(url, repository),
  });
  return { text: githubText(payload), blobSha: typeof payload.sha === 'string' ? payload.sha : null };
}

function isIsfFragment(entry) {
  return entry?.type === 'blob'
    && typeof entry.path === 'string'
    && isSafeRepositoryPath(entry.path)
    && /^ISF\/.+\.fs$/.test(entry.path);
}

function isWebglLesson(entry) {
  if (entry?.type !== 'blob' || typeof entry.path !== 'string' || !isSafeRepositoryPath(entry.path) || !entry.path.endsWith('.md')) {
    return false;
  }
  return /^webgl\/lessons\/[^/]+\.md$/.test(entry.path)
    || /^webgl\/lessons\/zh_cn\/[^/]+\.md$/.test(entry.path);
}

function isMatchingVertex(path, candidates) {
  const candidate = path.slice(0, -3) + '.vs';
  return candidates.get(candidate) || null;
}

function selectWebglLessons(tree) {
  const entries = tree.filter(isWebglLesson);
  const chinese = new Set(entries
    .filter((entry) => entry.path.startsWith('webgl/lessons/zh_cn/'))
    .map((entry) => entry.path.slice('webgl/lessons/zh_cn/'.length)));
  return entries
    .filter((entry) => entry.path.startsWith('webgl/lessons/zh_cn/') || !chinese.has(entry.path.slice('webgl/lessons/'.length)))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function webglCanonicalUrl(path) {
  const relative = path.slice('webgl/lessons/'.length).replace(/\.md$/, '.html');
  return `https://webglfundamentals.org/webgl/lessons/${relative}`;
}

function twiglSnapshotSource(payload) {
  const candidates = [
    payload?.graphics?.source,
    payload?.source,
    payload?.code,
    payload?.fragment,
    payload?.shader?.source,
    payload?.data?.source,
  ];
  const source = candidates.find((value) => typeof value === 'string');
  if (source === undefined) {
    return null;
  }
  const soundSource = typeof payload?.sound?.source === 'string' ? payload.sound.source : null;
  const totalBytes = Buffer.byteLength(source, 'utf8') + (soundSource ? Buffer.byteLength(soundSource, 'utf8') : 0);
  if (totalBytes > MAX_SOURCE_BYTES) {
    throw new ProviderServiceError('response_too_large', { provider: 'twigl', operation: 'import', retryable: false });
  }
  const mode = Number(payload?.graphics?.mode);
  return {
    source,
    soundSource,
    mode: Number.isSafeInteger(mode) && mode >= 0 && mode <= 11 ? mode : null,
  };
}

function twiglHasChannel(url) {
  try {
    return new URL(url).hostname === 'twigl.app' && new URL(url).searchParams.has('ch');
  } catch {
    return false;
  }
}

function githubSyncState(revision, cursor, total, status, now) {
  const value = typeof now === 'function' ? now() : Date.now();
  const date = value instanceof Date ? value : new Date(value);
  return {
    revision,
    cursor: String(cursor),
    total,
    status,
    updatedAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
  };
}

function safeResolvedSource(resolved) {
  if (resolved?.ref?.provider !== 'twigl' || resolved.metadata?.sourceType !== 'inline-user-source') {
    return resolved;
  }
  const { inlineSource, inlineSoundSource, source, soundSource, code, fragment, audio, ...metadata } = resolved.metadata;
  void inlineSource;
  void inlineSoundSource;
  void source;
  void soundSource;
  void code;
  void fragment;
  if (audio && typeof audio === 'object' && !Array.isArray(audio)) {
    const { inlineSoundSource: ignoredInlineSoundSource, source: ignoredSource, ...safeAudio } = audio;
    void ignoredInlineSoundSource;
    void ignoredSource;
    metadata.audio = safeAudio;
  }
  return {
    ...resolved,
    canonicalUrl: 'https://twigl.app/',
    metadata,
  };
}

/**
 * Provider-facing network and normalization seam. Public inputs are first
 * resolved by the fixed registry. The only outgoing requests here are built
 * from constant provider endpoints; no user URL, GitHub repository, or path
 * is forwarded as a request target.
 */
export function createProviderService({ registry, store, fetch, environment, now } = {}) {
  ensureRegistry(registry);
  ensureStore(store);
  // GitHub access is optional. The token is sent only to GitHub's fixed REST
  // endpoints, never stored, returned, logged, or forwarded to other hosts.
  const githubToken = typeof environment?.GITHUB_TOKEN === 'string'
    ? environment.GITHUB_TOKEN.trim()
    : '';
  const githubHeaders = Object.freeze({
    'User-Agent': 'shadertoy-netease-toolkit/0.2',
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  });
  const http = createBoundedHttpClient({ fetch, timeoutMs: 30_000 });

  async function importLink({ url, authorizationBasis, signal } = {}) {
    const context = { operation: 'import' };
    try {
      throwIfAborted(signal, context);
      let resolved;
      try {
        // Resolve first even for a rejected twigl channel link; recognition is
        // the security gate and must not be replaced by ad-hoc URL parsing.
        resolved = resolve(registry, url, 'import');
      } catch (error) {
        if (twiglHasChannel(url)) {
          throw new ProviderServiceError('unsupported_url', context);
        }
        throw error;
      }
      context.provider = resolved.ref.provider;
      context.ref = resolved.ref;
      const provider = resolved.ref.provider;
      let record;

      switch (provider) {
        case 'twigl': {
          let source = resolved.metadata?.inlineSource || null;
          let soundSource = resolved.metadata?.audio?.inlineSoundSource || null;
          let mode = Number.isInteger(resolved.metadata?.mode) ? resolved.metadata.mode : null;
          let provenance = { experimentalSnapshotEndpoint: false };
          if (!source && twiglHasChannel(url)) {
            throw new ProviderServiceError('unsupported_url', context);
          }
          const snapshotAuthorized = ['user-owned', 'licensed', 'author-permission'].includes(authorizationBasis);
          if (!source && resolved.metadata?.shareId && snapshotAuthorized) {
            const shareId = resolved.metadata.shareId;
            const endpoint = `${TWIGL_SNAPSHOT_ORIGIN}/snapshot/${encodeURIComponent(shareId)}.json`;
            const payload = await http.get(endpoint, {
              responseType: 'json',
              signal,
              allow: isFixedTwiglSnapshotUrl,
            });
            throwIfAborted(signal, context);
            const snapshot = twiglSnapshotSource(payload);
            source = snapshot?.source || null;
            soundSource = snapshot?.soundSource || null;
            mode = snapshot?.mode;
            provenance = {
              experimentalSnapshotEndpoint: true,
              endpoint: '/snapshot/<snapshotId>.json',
              enumerated: false,
            };
          } else if (!source && resolved.metadata?.shareId) {
            // A share id identifies a user work, not a reusable platform
            // asset. Do not read the snapshot until the caller has recorded
            // a work-specific source authorization basis.
            provenance = {
              experimentalSnapshotEndpoint: false,
              snapshotFetchSkippedByAuthorization: true,
              enumerated: false,
            };
          }
          record = normalizeTwiglResource({
            resolved,
            source,
            soundSource,
            mode,
            authorizationBasis,
            now,
            provenance,
          });
          break;
        }
        case 'godot-shaders': {
          const pageHtml = await http.get(resolved.canonicalUrl, {
            responseType: 'text',
            signal,
            allow: isFixedGodotUrl,
          });
          throwIfAborted(signal, context);
          const page = extractGodotPageMetadata(pageHtml);
          if (!page.postId || !/^\d+$/.test(page.postId)) {
            throw new ProviderServiceError('upstream_schema_changed', { ...context, resumable: false });
          }
          const policy = getGodotSourcePolicy(page, authorizationBasis);
          let apiPayload = null;
          if (policy.canFetchSource) {
            const endpoint = `${GODOT_ORIGIN}/wp-json/shader_data/shader/${page.postId}`;
            apiPayload = await http.get(endpoint, {
              responseType: 'json',
              signal,
              allow: isFixedGodotUrl,
            });
            throwIfAborted(signal, context);
          }
          record = normalizeGodotResource({ resolved, page, apiPayload, authorizationBasis, now });
          break;
        }
        case 'shaderfrog':
          record = normalizeLinkOnlyResource({
            resolved,
            title: `ShaderFrog ${resolved.ref.id}`,
            description: 'Reference-only ShaderFrog editor link. Production projects are not fetched.',
            authorizationBasis,
            now,
            tags: ['shaderfrog', 'reference-only'],
          });
          break;
        case 'book-of-shaders':
          record = normalizeLinkOnlyResource({
            resolved,
            title: `The Book of Shaders ${resolved.metadata?.chapter || resolved.ref.id}`,
            description: 'Reference-only chapter link. Page text and example code are not fetched or cached.',
            authorizationBasis,
            now,
            tags: ['the-book-of-shaders', 'reference-only'],
          });
          break;
        case 'isf':
        case 'webgl-fundamentals':
          throw new ProviderServiceError('operation_not_supported', context);
        case 'shadertoy':
          throw new ProviderServiceError('operation_not_supported', context);
        default:
          throw new ProviderServiceError('operation_not_supported', context);
      }

      throwIfAborted(signal, context);
      const resource = await persistResource(store, record, context);
      return {
        status: 'ok',
        provider,
        operation: 'import',
        ref: resolved.ref,
        resolved: safeResolvedSource(resolved),
        resource,
        sourceCached: Boolean(resource?.bodyBytes),
        authorizationBasis,
      };
    } catch (error) {
      return errorResult(error, context);
    }
  }

  async function syncGithubProvider({ provider, limit, signal, makeEntries, makeEligibleIds, makeRecord }) {
    const context = { provider, operation: 'sync' };
    const repository = REPOSITORIES[provider];
    throwIfAborted(signal, context);
    const runToken = await claimProviderSyncRun(store, provider, context);
    let completionReleasedLease = false;
    let hasPrimaryError = false;
    try {
      const state = await readState(store, provider, context);
      throwIfAborted(signal, context);
      const revision = await withSyncHeartbeat(
        store,
        provider,
        runToken,
        context,
        () => githubCommit(http, repository, signal, provider, githubHeaders),
      );
      throwIfAborted(signal, context);
      if (state?.revision === revision && state.status === 'complete') {
        return {
          status: 'complete',
          provider,
          operation: 'sync',
          revision,
          processed: 0,
          remaining: 0,
          resumable: false,
        };
      }
      const tree = await withSyncHeartbeat(
        store,
        provider,
        runToken,
        context,
        () => githubTree(http, repository, revision, signal, provider, githubHeaders),
      );
      throwIfAborted(signal, context);
      const entries = makeEntries(tree);
      if (entries.length === 0) {
        throw new ProviderServiceError('upstream_schema_changed', { ...context, resumable: true });
      }
      if (state?.revision === revision && Object.hasOwn(state, 'total')
        && (!Number.isSafeInteger(state.total) || state.total !== entries.length)) {
        throw new ProviderServiceError('upstream_schema_changed', { ...context, resumable: true });
      }
      const eligibleResourceIds = makeEligibleIds(entries);
      const cursor = state?.revision === revision ? Math.min(parseCursor(state.cursor), entries.length) : 0;
      let next = cursor;
      let processed = 0;
      while (next < entries.length && processed < limit) {
        throwIfAborted(signal, context);
        const entry = entries[next];
        const record = await makeRecord(entry, revision, tree, runToken, context);
        throwIfAborted(signal, context);
        await persistSyncResource(store, provider, runToken, revision, record, { ...context, ref: record.ref });
        next += 1;
        processed += 1;
        // The final completion state is written atomically with reconciliation
        // below. Until then, even a fully consumed cursor remains resumable.
        await persistSyncState(
          store,
          provider,
          runToken,
          githubSyncState(revision, next, entries.length, 'partial', now),
          context,
        );
      }
      const complete = next >= entries.length;
      if (complete) {
        throwIfAborted(signal, context);
        await completeProviderSync(
          store,
          provider,
          runToken,
          githubSyncState(revision, next, entries.length, 'complete', now),
          eligibleResourceIds,
          context,
        );
        completionReleasedLease = true;
      }
      return {
        status: complete ? 'complete' : 'partial',
        provider,
        operation: 'sync',
        revision,
        processed,
        remaining: Math.max(0, entries.length - next),
        cursor: String(next),
        total: entries.length,
        resumable: !complete,
      };
    } catch (error) {
      hasPrimaryError = true;
      throw error;
    } finally {
      if (!completionReleasedLease) {
        try {
          await releaseProviderSyncRun(store, provider, runToken, context);
        } catch (releaseError) {
          // The primary operation result is more useful than a best-effort
          // cleanup fault. A bounded lease eventually expires, so preserving
          // the original resumable upstream/store error is safe.
          if (!hasPrimaryError) throw releaseError;
        }
      }
    }
  }

  async function syncIsf(limit, signal) {
    return syncGithubProvider({
      provider: 'isf',
      limit,
      signal,
      makeEntries: (tree) => tree.filter(isIsfFragment).sort((left, right) => left.path.localeCompare(right.path)),
      makeEligibleIds: (entries) => entries.map((entry) => entry.path),
      makeRecord: async (entry, revision, tree, runToken, context) => {
        const files = new Map(tree
          .filter((candidate) => candidate?.type === 'blob' && typeof candidate.path === 'string' && isSafeRepositoryPath(candidate.path))
          .map((candidate) => [candidate.path, candidate]));
        const fragment = await withSyncHeartbeat(
          store,
          'isf',
          runToken,
          context,
          () => githubFile(http, REPOSITORIES.isf, revision, entry.path, signal, 'isf', githubHeaders),
        );
        const vertexEntry = isMatchingVertex(entry.path, files);
        const vertex = vertexEntry
          ? await withSyncHeartbeat(
            store,
            'isf',
            runToken,
            context,
            () => githubFile(http, REPOSITORIES.isf, revision, vertexEntry.path, signal, 'isf', githubHeaders),
          )
          : null;
        return normalizeIsfResource({
          ref: { provider: 'isf', id: entry.path },
          canonicalUrl: githubCanonicalUrl(REPOSITORIES.isf, revision, entry.path),
          path: entry.path,
          fragmentSource: fragment.text,
          vertexSource: vertex?.text || null,
          commit: revision,
          blobSha: entry.sha || fragment.blobSha,
          now,
        });
      },
    });
  }

  async function syncWebgl(limit, signal) {
    function resolveLesson(entry) {
      const canonicalUrl = webglCanonicalUrl(entry.path);
      const resolved = registry.resolveUrl(canonicalUrl);
      if (!resolved || resolved.ref?.provider !== 'webgl-fundamentals') {
        throw new ProviderServiceError('upstream_schema_changed', {
          provider: 'webgl-fundamentals',
          operation: 'sync',
          resumable: true,
        });
      }
      return { canonicalUrl, resolved };
    }

    return syncGithubProvider({
      provider: 'webgl-fundamentals',
      limit,
      signal,
      makeEntries: selectWebglLessons,
      makeEligibleIds: (entries) => entries.map((entry) => resolveLesson(entry).resolved.ref.id),
      makeRecord: async (entry, revision, tree, runToken, context) => {
        void tree;
        const markdown = await withSyncHeartbeat(
          store,
          'webgl-fundamentals',
          runToken,
          context,
          () => githubFile(http, REPOSITORIES['webgl-fundamentals'], revision, entry.path, signal, 'webgl-fundamentals', githubHeaders),
        );
        const { canonicalUrl, resolved } = resolveLesson(entry);
        return normalizeWebglLesson({
          ref: resolved.ref,
          canonicalUrl: resolved.canonicalUrl,
          path: entry.path,
          source: markdown.text,
          commit: revision,
          blobSha: entry.sha || markdown.blobSha,
          now,
        });
      },
    });
  }

  async function syncBookOfShaders(limit, signal) {
    const provider = 'book-of-shaders';
    const context = { provider, operation: 'sync' };
    throwIfAborted(signal, context);
    const runToken = await claimProviderSyncRun(store, provider, context);
    let completionReleasedLease = false;
    let hasPrimaryError = false;
    try {
      const state = await readState(store, provider, context);
      const revision = 'built-in-topic-index-v1';
      const resolvedTopics = BOOK_OF_SHADERS_TOPICS.map((topic) => {
        const resolved = registry.resolveUrl(topic[3]);
        if (!resolved || resolved.ref?.provider !== provider) {
          throw new ProviderServiceError('upstream_schema_changed', { ...context, resumable: true });
        }
        return { topic, resolved };
      });
      const eligibleResourceIds = resolvedTopics.map(({ resolved }) => resolved.ref.id);
      const cursor = state?.revision === revision ? Math.min(parseCursor(state.cursor), resolvedTopics.length) : 0;
      let next = cursor;
      let processed = 0;
      while (next < resolvedTopics.length && processed < limit) {
        throwIfAborted(signal, context);
        const { topic, resolved } = resolvedTopics[next];
        const record = normalizeBookOfShadersTopic(topic, resolved, now);
        await persistSyncResource(store, provider, runToken, revision, record, { ...context, ref: record.ref });
        next += 1;
        processed += 1;
        await persistSyncState(
          store,
          provider,
          runToken,
          githubSyncState(revision, next, resolvedTopics.length, 'partial', now),
          context,
        );
      }
      const complete = next >= resolvedTopics.length;
      if (complete) {
        throwIfAborted(signal, context);
        await completeProviderSync(
          store,
          provider,
          runToken,
          githubSyncState(revision, next, resolvedTopics.length, 'complete', now),
          eligibleResourceIds,
          context,
          'built-in-original-topic-index',
        );
        completionReleasedLease = true;
      }
      return {
        status: complete ? 'complete' : 'partial',
        provider,
        operation: 'sync',
        revision,
        processed,
        remaining: Math.max(0, resolvedTopics.length - next),
        cursor: String(next),
        total: resolvedTopics.length,
        resumable: !complete,
        offline: true,
      };
    } catch (error) {
      hasPrimaryError = true;
      throw error;
    } finally {
      if (!completionReleasedLease) {
        try {
          await releaseProviderSyncRun(store, provider, runToken, context);
        } catch (releaseError) {
          if (!hasPrimaryError) throw releaseError;
        }
      }
    }
  }

  async function syncStep({ provider, limit, signal } = {}) {
    const context = { provider: typeof provider === 'string' ? provider : null, operation: 'sync' };
    try {
      const boundedLimit = normaliseLimit(limit);
      throwIfAborted(signal, context);
      if (!registry.get(provider)) {
        throw new ProviderServiceError('invalid_ref', context);
      }
      switch (provider) {
        case 'isf':
          return await syncIsf(boundedLimit, signal);
        case 'webgl-fundamentals':
          return await syncWebgl(boundedLimit, signal);
        case 'book-of-shaders':
          return await syncBookOfShaders(boundedLimit, signal);
        case 'shadertoy':
        case 'twigl':
        case 'shaderfrog':
        case 'godot-shaders':
        default:
          throw new ProviderServiceError('operation_not_supported', context);
      }
    } catch (error) {
      return errorResult(error, context);
    }
  }

  return Object.freeze({
    importLink,
    syncStep,
    resolveLink(url) {
      try {
        return safeResolvedSource(resolve(registry, url, 'resolve'));
      } catch {
        return null;
      }
    },
    limits: Object.freeze({ maxStepLimit: MAX_STEP_LIMIT, timeoutMs: http.timeoutMs, maxResponseBytes: http.maxResponseBytes }),
  });
}
