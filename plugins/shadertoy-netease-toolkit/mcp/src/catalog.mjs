import { parseShaderId, ShadertoyApiError } from './shadertoy-api.mjs';

const DEFAULT_SYNC_STEP_LIMIT = 10;
const MAX_SYNC_STEP_LIMIT = 25;
const MAX_PENDING_SCAN_LIMIT = 500;
const TERMINAL_FETCH_ERROR_PREFIX = 'terminal:';
const SAFE_PUBLIC_ERROR_MESSAGES = {
  api_auth_failed: 'The Shadertoy API rejected the configured credentials.',
  auth_required: 'A Shadertoy API key is required before synchronization can start.',
  cancelled: 'The synchronization operation was cancelled.',
  fetch_unavailable: 'No fetch implementation is available for the Shadertoy API client.',
  http_error: 'The Shadertoy API returned an unexpected HTTP status.',
  id_mismatch: 'The Shadertoy API returned a shader different from the requested id.',
  invalid_client: 'The Shadertoy client does not implement the required API method.',
  invalid_json: 'The Shadertoy API returned invalid JSON.',
  invalid_response: 'The Shadertoy API returned an invalid response.',
  invalid_shader_id: 'The Shadertoy API returned an invalid shader id.',
  invalid_store: 'The library store does not implement the required synchronization method.',
  network_error: 'The request to the Shadertoy API failed.',
  rate_limited: 'The Shadertoy API rate limit was reached.',
  response_too_large: 'The Shadertoy API response exceeded the configured size limit.',
  schema_error: 'The Shadertoy API returned an unknown response schema.',
  server_error: 'The Shadertoy API is temporarily unavailable.',
  timeout: 'The Shadertoy API request timed out.',
};

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isAbortSignal(value) {
  return Boolean(value)
    && typeof value === 'object'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function'
    && typeof value.aborted === 'boolean';
}

function cancellationError() {
  return new ShadertoyApiError(
    'cancelled',
    'The synchronization operation was cancelled.',
    { retryable: false },
  );
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw cancellationError();
  }
}

/**
 * Do not leave a timed-out caller waiting on an uncooperative client promise.
 * Once the signal wins, its eventual resolution is deliberately ignored so it
 * cannot resume this synchronization flow and write to the library later.
 */
function awaitOperationWithSignal(operation, signal) {
  throwIfAborted(signal);
  if (!signal) {
    return Promise.resolve().then(operation);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => settle(reject, cancellationError());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let pending;
    try {
      pending = operation();
    } catch (error) {
      settle(reject, error);
      return;
    }
    Promise.resolve(pending).then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
  });
}

function isCancellation(error) {
  return error instanceof ShadertoyApiError && error.code === 'cancelled';
}

function copyJson(value, seen = new WeakSet(), depth = 0) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'object' || depth > 40) {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const copy = value.map((item) => copyJson(item, seen, depth + 1));
    seen.delete(value);
    return copy;
  }

  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    copy[key] = copyJson(item, seen, depth + 1);
  }
  seen.delete(value);
  return copy;
}

function asText(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asNullableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asFetchedAt(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function normalizeIoEntry(entry, index) {
  if (!isRecord(entry)) {
    return { channel: index, value: copyJson(entry) };
  }

  const normalized = copyJson(entry);
  if (!hasOwn(normalized, 'channel')) {
    normalized.channel = index;
  }
  return normalized;
}

function normalizeRenderpass(renderpass, index) {
  const pass = isRecord(renderpass) ? renderpass : {};
  const inputs = Array.isArray(pass.inputs) ? pass.inputs : [];
  const outputs = Array.isArray(pass.outputs) ? pass.outputs : [];
  return {
    index,
    type: asText(pass.type, 'image'),
    name: asText(pass.name),
    description: asText(pass.description),
    code: asText(pass.code),
    inputs: inputs.map(normalizeIoEntry),
    outputs: outputs.map(normalizeIoEntry),
  };
}

function normalizeTags(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const tags = [];
  const seen = new Set();
  for (const tag of value) {
    if (typeof tag === 'string' && tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

function unwrapShader(payload) {
  if (!isRecord(payload)) {
    throw new ShadertoyApiError(
      'invalid_response',
      'The Shadertoy API payload is not an object.',
      { retryable: false },
    );
  }
  const shader = hasOwn(payload, 'Shader') ? payload.Shader : payload;
  if (!isRecord(shader)) {
    throw new ShadertoyApiError(
      'invalid_response',
      'The Shadertoy API payload did not contain a shader object.',
      { retryable: false },
    );
  }
  return shader;
}

function makeAuthRequiredResult(kind) {
  return {
    status: 'auth_required',
    runId: null,
    kind,
    stats: {},
    error: {
      code: 'auth_required',
      message: 'A Shadertoy API key is required before synchronization can start.',
      status: null,
      retryAfterMs: null,
      retryable: false,
    },
  };
}

function publicError(error) {
  if (error instanceof ShadertoyApiError) {
    const code = hasOwn(SAFE_PUBLIC_ERROR_MESSAGES, error.code) ? error.code : 'sync_error';
    return {
      code,
      // Do not serialize arbitrary upstream Error text: it may contain the
      // API request URL and therefore the query-string key.
      message: SAFE_PUBLIC_ERROR_MESSAGES[code] || 'The synchronization operation failed.',
      status: Number.isInteger(error.status) ? error.status : null,
      retryAfterMs: Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : null,
      retryable: Boolean(error.retryable),
      attempts: Number.isInteger(error.attempts) ? error.attempts : null,
    };
  }
  return {
    code: 'sync_error',
    message: 'The synchronization operation failed.',
    status: null,
    retryAfterMs: null,
    retryable: false,
    attempts: null,
  };
}

function hasConfiguredClient(client) {
  if (!client || typeof client !== 'object') {
    return false;
  }
  try {
    if (typeof client.hasApiKey === 'function') {
      return Boolean(client.hasApiKey());
    }
    if (typeof client.hasApiKey === 'boolean') {
      return client.hasApiKey;
    }
    if (typeof client.isConfigured === 'function') {
      return Boolean(client.isConfigured());
    }
    if (typeof client.isConfigured === 'boolean') {
      return client.isConfigured;
    }
  } catch {
    return false;
  }
  // Test doubles and compatible clients may intentionally keep key state private.
  return true;
}

function getStoreMethod(store, methodName) {
  if (!store || typeof store[methodName] !== 'function') {
    throw new ShadertoyApiError(
      'invalid_store',
      'The library store does not implement the required synchronization method.',
      { retryable: false },
    );
  }
  return store[methodName].bind(store);
}

function getClientMethod(client, methodName) {
  if (!client || typeof client[methodName] !== 'function') {
    throw new ShadertoyApiError(
      'invalid_client',
      'The Shadertoy client does not implement the required API method.',
      { retryable: false },
    );
  }
  return client[methodName].bind(client);
}

function syncStepLimit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SYNC_STEP_LIMIT;
  }
  return Math.max(1, Math.min(MAX_SYNC_STEP_LIMIT, Math.floor(numeric)));
}

function syncStepDuration(value) {
  if (value == null) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
}

function timestampFrom(clock) {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
}

function withStepProgress(result) {
  const stats = result.stats;
  // listPending is intentionally paged by the store.  `pending` is therefore
  // only a scanned lower bound, never the total number of queued projects.
  stats.remaining = Math.max(0, stats.eligibleScanned - stats.processed);
  stats.remainingExact = !stats.hasMore;
  // A cancellation can win after a pending entry was selected but before its
  // write completed. Keep the step resumable even when this local scan had no
  // lookahead, so callers never mistake an interrupted batch for completion.
  const resumable = result.status === 'cancelled'
    || stats.remaining > 0
    || stats.hasMore
    || stats.retryableFailures > 0;
  return {
    ...result,
    resumable,
    progress: {
      pending: stats.pending,
      scanned: stats.scanned,
      scanLimit: stats.scanLimit,
      terminalSkipped: stats.terminalSkipped,
      selected: stats.selected,
      processed: stats.processed,
      remaining: stats.remaining,
      remainingExact: stats.remainingExact,
      retryableFailures: stats.retryableFailures,
      terminalFailures: stats.terminalFailures,
      hasMore: stats.hasMore,
      timeLimited: stats.timeLimited,
    },
  };
}

async function finishRun(store, runId, result) {
  const finishSync = getStoreMethod(store, 'finishSync');
  await finishSync(runId, {
    // LibraryStore persists the detailed structured auth result below, while
    // its lifecycle enum intentionally remains one of success/partial/failed.
    status: result.status === 'auth_required' ? 'failed' : result.status,
    stats: result.stats,
    error: result.error || null,
  });
}

function fetchErrorForStore(error) {
  const safeError = publicError(error);
  // The current LibraryStore persists a bounded text error.  Keep the code for
  // diagnosis, but never serialize arbitrary upstream error text or a URL.
  return `${safeError.code}: ${safeError.message}`;
}

function terminalFetchErrorForStore(error) {
  return `${TERMINAL_FETCH_ERROR_PREFIX}${fetchErrorForStore(error)}`;
}

function isTerminalPending(value) {
  return isRecord(value)
    && typeof value.fetchError === 'string'
    && value.fetchError.startsWith(TERMINAL_FETCH_ERROR_PREFIX);
}

function isTerminalProjectError(error) {
  if (!(error instanceof ShadertoyApiError) || error.retryable) {
    return false;
  }
  return !['auth_required', 'api_auth_failed', 'cancelled', 'fetch_unavailable'].includes(error.code);
}

function isGlobalClientError(error) {
  return error instanceof ShadertoyApiError
    && ['auth_required', 'api_auth_failed', 'fetch_unavailable'].includes(error.code);
}

function makeCancelledResult(kind, runId, stats) {
  return {
    status: 'cancelled',
    runId: runId || null,
    kind,
    stats,
    error: publicError(cancellationError()),
  };
}

async function listPendingCandidates(listPending, settings, limit, signal) {
  let scanLimit = Math.min(MAX_PENDING_SCAN_LIMIT, limit + 1);
  let pending = [];
  let eligible = [];
  while (true) {
    throwIfAborted(signal);
    pending = await awaitOperationWithSignal(() => listPending({
      limit: scanLimit,
      force: Boolean(settings.force),
      staleBefore: settings.staleBefore,
    }), signal);
    throwIfAborted(signal);
    if (!Array.isArray(pending)) {
      throw new ShadertoyApiError(
        'invalid_response',
        'The library store returned an invalid pending shader list.',
        { retryable: false },
      );
    }
    eligible = pending.filter((value) => !isTerminalPending(value));
    const terminalCount = pending.length - eligible.length;
    const needTerminalLookahead = terminalCount > 0 && pending.length === scanLimit;
    if (
      (eligible.length >= limit && !needTerminalLookahead)
      || pending.length < scanLimit
      || scanLimit >= MAX_PENDING_SCAN_LIMIT
    ) {
      return {
        pending,
        eligible,
        scanLimit,
        hasMore: eligible.length > limit || pending.length === scanLimit,
      };
    }
    scanLimit = Math.min(MAX_PENDING_SCAN_LIMIT, Math.max(scanLimit + 1, scanLimit * 2));
  }
}

async function finishOrReportStoreFailure(store, runId, result) {
  try {
    await finishRun(store, runId, result);
    return result;
  } catch {
    return {
      status: 'failed',
      runId,
      kind: result.kind,
      stats: result.stats,
      resumable: result.resumable,
      progress: result.progress,
      error: {
        code: 'store_error',
        message: 'The library store could not record synchronization completion.',
        status: null,
        retryAfterMs: null,
        retryable: false,
        attempts: null,
      },
    };
  }
}

/**
 * Converts Shadertoy's `{ Shader: { info, renderpass } }` response into the
 * project record persisted by the local library.  Input/output descriptors are
 * retained as metadata only; this function never fetches referenced assets.
 */
export function normalizeApiProject(payload, options = {}) {
  const settings = isRecord(options) ? options : {};
  const shader = unwrapShader(payload);
  const info = isRecord(shader.info) ? shader.info : {};
  const id = parseShaderId(info.id || shader.id);
  if (!id) {
    throw new ShadertoyApiError(
      'invalid_shader_id',
      'The Shadertoy payload did not include a valid shader id.',
      { retryable: false },
    );
  }

  const rawPasses = Array.isArray(shader.renderpass)
    ? shader.renderpass
    : Array.isArray(shader.renderpasses)
      ? shader.renderpasses
      : [];
  const renderpasses = rawPasses.map(normalizeRenderpass);
  const sourceUrl = `https://www.shadertoy.com/view/${id}`;

  return {
    id,
    title: asText(info.name, id),
    author: asText(info.username),
    description: asText(info.description),
    tags: normalizeTags(info.tags),
    publishedAt: hasOwn(info, 'date') ? copyJson(info.date) : null,
    updatedAt: hasOwn(info, 'date') ? copyJson(info.date) : null,
    viewed: asNullableNumber(info.viewed),
    likes: asNullableNumber(info.likes),
    renderpasses,
    // Preserve the upstream spelling for consumers that already use it.
    renderpass: renderpasses,
    source: {
      provider: 'shadertoy',
      url: sourceUrl,
    },
    sourceUrl,
    fetchedAt: asFetchedAt(settings.fetchedAt),
    remoteMetadata: {
      flags: hasOwn(info, 'flags') ? copyJson(info.flags) : null,
      published: hasOwn(info, 'published') ? copyJson(info.published) : null,
    },
    rawPayload: copyJson(payload),
  };
}

/**
 * Fetches the official, ID-only Shadertoy catalogue and delegates persistence
 * to LibraryStore.  It deliberately does not fetch individual shader payloads.
 */
export async function syncCatalog(store, client, options = {}) {
  const kind = 'catalog';
  if (!hasConfiguredClient(client)) {
    return makeAuthRequiredResult(kind);
  }

  const settings = isRecord(options) ? options : {};
  const signal = isAbortSignal(settings.signal) ? settings.signal : null;
  let runId;
  const stats = {
    listed: 0,
    uniqueIds: 0,
    marked: 0,
  };
  try {
    throwIfAborted(signal);
    const beginSync = getStoreMethod(store, 'beginSync');
    const listAllShaderIds = getClientMethod(client, 'listAllShaderIds');
    const markCatalog = getStoreMethod(store, 'markCatalog');
    runId = await awaitOperationWithSignal(() => beginSync(kind), signal);
    throwIfAborted(signal);
    const receivedIds = await awaitOperationWithSignal(
      () => listAllShaderIds({ signal }),
      signal,
    );
    throwIfAborted(signal);
    if (!Array.isArray(receivedIds)) {
      throw new ShadertoyApiError(
        'invalid_response',
        'The Shadertoy client returned an invalid shader id list.',
        { retryable: false },
      );
    }

    const ids = [];
    const seen = new Set();
    for (const value of receivedIds) {
      const id = parseShaderId(value);
      if (!id) {
        throw new ShadertoyApiError(
          'invalid_shader_id',
          'The Shadertoy client returned an invalid shader id.',
          { retryable: false },
        );
      }
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }

    stats.listed = receivedIds.length;
    stats.uniqueIds = ids.length;
    throwIfAborted(signal);
    const markResult = await awaitOperationWithSignal(() => markCatalog(ids, runId), signal);
    stats.marked = typeof markResult === 'number' && Number.isFinite(markResult)
      ? markResult
      : ids.length;
    if (isRecord(markResult)) {
      stats.catalog = copyJson(markResult);
    }
    throwIfAborted(signal);
    return await finishOrReportStoreFailure(store, runId, {
      status: 'success',
      runId,
      kind,
      stats,
    });
  } catch (error) {
    if (isCancellation(error)) {
      const result = makeCancelledResult(kind, runId, stats);
      return runId == null ? result : finishOrReportStoreFailure(store, runId, result);
    }
    const result = {
      status: error instanceof ShadertoyApiError && error.code === 'auth_required'
        ? 'auth_required'
        : 'failed',
      runId: runId || null,
      kind,
      stats,
      error: publicError(error),
    };
    if (runId == null) {
      return result;
    }
    return finishOrReportStoreFailure(store, runId, result);
  }
}

/**
 * Fetches and stores at most one bounded batch of pending shader payloads.
 * Network and normalization failures are recorded per id and do not abort the
 * remaining IDs in the batch.
 */
export async function syncStep(store, client, options = {}) {
  const kind = 'fetch';
  if (!hasConfiguredClient(client)) {
    return makeAuthRequiredResult(kind);
  }

  const settings = isRecord(options) ? options : {};
  const signal = isAbortSignal(settings.signal) ? settings.signal : null;
  const limit = syncStepLimit(settings.limit);
  const maxDurationMs = syncStepDuration(settings.maxDurationMs);
  const clock = typeof settings.now === 'function' ? settings.now : Date.now;
  const startedAt = timestampFrom(clock);
  const stats = {
    limit,
    maxDurationMs,
    pending: 0,
    scanned: 0,
    scanLimit: 0,
    eligibleScanned: 0,
    terminalSkipped: 0,
    selected: 0,
    processed: 0,
    fetched: 0,
    upserted: 0,
    failed: 0,
    retryableFailures: 0,
    terminalFailures: 0,
    invalidIds: 0,
    remaining: 0,
    remainingExact: true,
    hasMore: false,
    timeLimited: false,
  };
  let runId;
  try {
    throwIfAborted(signal);
    const beginSync = getStoreMethod(store, 'beginSync');
    const listPending = getStoreMethod(store, 'listPending');
    const markFetchError = getStoreMethod(store, 'markFetchError');
    const markFetchTerminal = typeof store?.markFetchTerminal === 'function'
      ? store.markFetchTerminal.bind(store)
      : null;
    const upsertProject = getStoreMethod(store, 'upsertProject');
    const getShader = getClientMethod(client, 'getShader');
    runId = await awaitOperationWithSignal(() => beginSync(kind), signal);
    throwIfAborted(signal);
    const scan = await listPendingCandidates(listPending, settings, limit, signal);
    stats.pending = scan.pending.length;
    stats.scanned = scan.pending.length;
    stats.scanLimit = scan.scanLimit;
    stats.eligibleScanned = scan.eligible.length;
    stats.terminalSkipped = scan.pending.length - scan.eligible.length;
    stats.hasMore = scan.hasMore;
    const selected = scan.eligible.slice(0, limit);
    stats.selected = selected.length;
    for (const pendingValue of selected) {
      throwIfAborted(signal);
      if (maxDurationMs != null && timestampFrom(clock) - startedAt >= maxDurationMs) {
        stats.timeLimited = true;
        break;
      }
      const candidate = isRecord(pendingValue) ? pendingValue.id : pendingValue;
      const id = parseShaderId(candidate);
      stats.processed += 1;
      if (!id) {
        stats.invalidIds += 1;
        stats.failed += 1;
        stats.terminalFailures += 1;
        continue;
      }

      try {
        throwIfAborted(signal);
        const payload = await awaitOperationWithSignal(() => getShader(id, { signal }), signal);
        throwIfAborted(signal);
        const project = normalizeApiProject(payload, { fetchedAt: settings.fetchedAt });
        if (project.id !== id) {
          throw new ShadertoyApiError(
            'id_mismatch',
            'The Shadertoy API returned a shader different from the requested id.',
            { retryable: false },
          );
        }
        stats.fetched += 1;
        throwIfAborted(signal);
        await awaitOperationWithSignal(
          () => upsertProject(project, { syncRunId: runId }),
          signal,
        );
        stats.upserted += 1;
      } catch (error) {
        if (isCancellation(error)) {
          throw error;
        }
        if (isGlobalClientError(error)) {
          throw error;
        }
        stats.failed += 1;
        const terminal = isTerminalProjectError(error);
        if (terminal) {
          stats.terminalFailures += 1;
        } else {
          stats.retryableFailures += 1;
        }
        throwIfAborted(signal);
        try {
          const markFailure = terminal && markFetchTerminal
            ? markFetchTerminal
            : markFetchError;
          const errorForStore = terminal && !markFetchTerminal
            ? terminalFetchErrorForStore(error)
            : fetchErrorForStore(error);
          await awaitOperationWithSignal(
            () => markFailure(id, errorForStore),
            signal,
          );
        } catch (storeError) {
          if (isCancellation(storeError)) {
            throw storeError;
          }
          // A terminal result is only terminal after its durable marker has
          // been recorded. If that write failed, leave the queue resumable.
          if (terminal) {
            stats.retryableFailures += 1;
          }
          // The final run status still reports a partial failure if this audit write fails.
        }
        throwIfAborted(signal);
      }
    }

    throwIfAborted(signal);
    const result = withStepProgress({
      status: 'success',
      runId,
      kind,
      stats,
    });
    if (stats.failed > 0 || result.resumable) {
      result.status = 'partial';
    }
    return finishOrReportStoreFailure(store, runId, result);
  } catch (error) {
    if (isCancellation(error)) {
      const result = withStepProgress(makeCancelledResult(kind, runId, stats));
      return runId == null ? result : finishOrReportStoreFailure(store, runId, result);
    }
    const result = withStepProgress({
      status: error instanceof ShadertoyApiError && error.code === 'auth_required'
        ? 'auth_required'
        : 'failed',
      runId: runId || null,
      kind,
      stats,
      error: publicError(error),
    });
    if (runId == null) {
      return result;
    }
    return finishOrReportStoreFailure(store, runId, result);
  }
}
