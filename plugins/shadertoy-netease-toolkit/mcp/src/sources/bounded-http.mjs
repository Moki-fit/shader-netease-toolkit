const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const SAFE_MESSAGES = Object.freeze({
  cancelled: 'The provider request was cancelled.',
  fetch_unavailable: 'No fetch implementation is available for this provider request.',
  http_error: 'The upstream provider returned an unexpected HTTP status.',
  invalid_json: 'The upstream provider returned invalid JSON.',
  invalid_response: 'The upstream provider returned an invalid response.',
  network_error: 'The request to the upstream provider failed.',
  redirect_blocked: 'The upstream provider returned a redirect, which is not followed.',
  response_too_large: 'The upstream provider response exceeded the 2 MiB limit.',
  upstream_timeout: 'The upstream provider request timed out.',
});

export class BoundedHttpError extends Error {
  constructor(code, options = {}) {
    super(SAFE_MESSAGES[code] || SAFE_MESSAGES.network_error);
    this.name = 'BoundedHttpError';
    this.code = Object.prototype.hasOwnProperty.call(SAFE_MESSAGES, code) ? code : 'network_error';
    this.status = Number.isInteger(options.status) ? options.status : null;
    this.retryable = options.retryable !== false;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      httpStatus: this.status,
      retryable: this.retryable,
    };
  }
}

function isAbortSignal(value) {
  return Boolean(value)
    && typeof value === 'object'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function'
    && typeof value.aborted === 'boolean';
}

function cancellationError() {
  return new BoundedHttpError('cancelled', { retryable: false });
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw cancellationError();
  }
}

function headerValue(headers, name) {
  if (!headers) {
    return null;
  }
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value == null ? null : String(value);
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) {
      return value == null ? null : String(value);
    }
  }
  return null;
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function cancelBody(response) {
  try {
    const cancellation = response?.body?.cancel?.();
    if (cancellation?.catch) {
      cancellation.catch(() => {});
    }
  } catch {
    // Do not replace the bounded, safe error with a body implementation error.
  }
}

function cancelReader(reader) {
  try {
    const cancellation = reader?.cancel?.();
    if (cancellation?.catch) {
      cancellation.catch(() => {});
    }
  } catch {
    // A reader can already be closed; that is safe to ignore.
  }
}

async function withSignal(value, signal) {
  throwIfAborted(signal);
  if (!signal) {
    return value;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(result);
    };
    const onAbort = () => finish(reject, cancellationError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

function contentLengthWithinBound(response) {
  const raw = headerValue(response?.headers, 'content-length');
  if (raw == null || !/^\d+$/.test(raw.trim())) {
    return;
  }
  if (Number(raw) > MAX_RESPONSE_BYTES) {
    throw new BoundedHttpError('response_too_large', { retryable: false });
  }
}

async function readText(response, signal) {
  contentLengthWithinBound(response);
  const stream = response?.body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    let complete = false;
    try {
      while (true) {
        const next = await withSignal(reader.read(), signal);
        if (next.done) {
          complete = true;
          break;
        }
        const chunk = asUint8Array(next.value);
        if (!chunk) {
          throw new BoundedHttpError('invalid_response', { retryable: false });
        }
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          cancelReader(reader);
          throw new BoundedHttpError('response_too_large', { retryable: false });
        }
        chunks.push(chunk);
      }
    } finally {
      if (!complete) {
        cancelReader(reader);
      }
      try {
        reader.releaseLock?.();
      } catch {
        // Nothing else must happen after a malformed stream implementation.
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  if (typeof response?.arrayBuffer === 'function') {
    const buffer = await withSignal(response.arrayBuffer(), signal);
    const bytes = asUint8Array(buffer);
    if (!bytes || bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw new BoundedHttpError('response_too_large', { retryable: false });
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  if (typeof response?.text === 'function') {
    const text = await withSignal(response.text(), signal);
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new BoundedHttpError('response_too_large', { retryable: false });
    }
    return text;
  }
  throw new BoundedHttpError('invalid_response', { retryable: false });
}

function normaliseTimeout(value) {
  if (value === undefined || value === null) {
    return DEFAULT_TIMEOUT_MS;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.floor(numeric));
}

/**
 * A deliberately small HTTP boundary for fixed-provider endpoints. Callers
 * must supply `allow(url) === true`; the provider service owns those fixed
 * predicates and never forwards arbitrary caller URLs here.
 */
export function createBoundedHttpClient(options = {}) {
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : typeof globalThis.fetch === 'function'
      ? globalThis.fetch.bind(globalThis)
      : null;
  const timeoutMs = normaliseTimeout(options.timeoutMs);
  const AbortControllerClass = options.AbortController || globalThis.AbortController || null;
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;

  async function get(url, requestOptions = {}) {
    const { allow, signal, responseType = 'text', headers = {} } = requestOptions;
    if (!fetchImpl) {
      throw new BoundedHttpError('fetch_unavailable', { retryable: false });
    }
    if (typeof allow !== 'function' || allow(url) !== true) {
      throw new BoundedHttpError('invalid_response', { retryable: false });
    }
    throwIfAborted(signal);

    let controller = null;
    try {
      controller = AbortControllerClass ? new AbortControllerClass() : null;
    } catch {
      controller = null;
    }
    const requestSignal = controller?.signal || signal;
    let detach = () => {};
    if (controller && isAbortSignal(signal)) {
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      detach = () => signal.removeEventListener('abort', abort);
    }

    let timedOut = false;
    let response = null;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimer(() => {
        timedOut = true;
        controller?.abort();
        reject(new BoundedHttpError('upstream_timeout'));
      }, timeoutMs);
    });
    try {
      const init = {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: responseType === 'json' ? 'application/json' : 'text/plain, text/markdown, text/html;q=0.9, */*;q=0.1',
          ...headers,
        },
      };
      if (requestSignal) {
        init.signal = requestSignal;
      }
      response = await Promise.race([
        withSignal(Promise.resolve().then(() => fetchImpl(url, init)), signal),
        timeout,
      ]);
      if (!response || typeof response !== 'object') {
        throw new BoundedHttpError('invalid_response', { retryable: false });
      }
      const status = Number(response.status);
      if (status >= 300 && status < 400) {
        cancelBody(response);
        throw new BoundedHttpError('redirect_blocked', { status, retryable: false });
      }
      if (!Number.isInteger(status) || status < 200 || status >= 300) {
        cancelBody(response);
        throw new BoundedHttpError('http_error', {
          status: Number.isInteger(status) ? status : null,
          retryable: status === 429 || (status >= 500 && status < 600),
        });
      }
      const text = await Promise.race([readText(response, requestSignal), timeout]);
      throwIfAborted(signal);
      if (responseType === 'json') {
        try {
          return JSON.parse(text);
        } catch {
          throw new BoundedHttpError('invalid_json', { retryable: false });
        }
      }
      return text;
    } catch (error) {
      if (timedOut) {
        cancelBody(response);
        throw new BoundedHttpError('upstream_timeout');
      }
      if (signal?.aborted || error?.code === 'cancelled') {
        cancelBody(response);
        throw cancellationError();
      }
      if (error instanceof BoundedHttpError) {
        throw error;
      }
      cancelBody(response);
      throw new BoundedHttpError('network_error');
    } finally {
      clearTimer(timer);
      detach();
    }
  }

  return Object.freeze({ get, timeoutMs, maxResponseBytes: MAX_RESPONSE_BYTES });
}
