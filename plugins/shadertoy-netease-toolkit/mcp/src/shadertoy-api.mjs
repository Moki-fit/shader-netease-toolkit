const SHADERTOY_ORIGIN = 'https://www.shadertoy.com';
const SHADERTOY_API_PATH = '/api/v1/shaders';
const SHADER_ID_PATTERN = /^[A-Za-z0-9]{6}$/;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_RATE_PER_SECOND = 0.5;
const MAX_RATE_PER_SECOND = 2;
const REQUIRED_USER_AGENT_NOTE = 'uses Shadertoy.com API';

function asPositiveFiniteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function asNonNegativeInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback;
}

function readHeader(headers, name) {
  if (!headers) {
    return null;
  }

  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value == null ? null : String(value);
  }

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lowerName) {
      return value == null ? null : String(value);
    }
  }
  return null;
}

function isSuccessfulStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function parseContentLength(response, maxResponseBytes) {
  const rawValue = readHeader(response && response.headers, 'content-length');
  if (rawValue == null || !/^\d+$/.test(rawValue.trim())) {
    return;
  }

  const byteLength = Number(rawValue);
  if (Number.isSafeInteger(byteLength) && byteLength > maxResponseBytes) {
    throw new ShadertoyApiError(
      'response_too_large',
      'The Shadertoy API response exceeded the configured size limit.',
      { retryable: false },
    );
  }
}

function concatChunks(chunks, totalLength) {
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return null;
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

function cancellationError() {
  return new ShadertoyApiError(
    'cancelled',
    'The Shadertoy API request was cancelled.',
    { retryable: false },
  );
}

function isAbortSignal(value) {
  return Boolean(value)
    && typeof value === 'object'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function'
    && typeof value.aborted === 'boolean';
}

function signalFromOptions(options) {
  const candidate = isAbortSignal(options) ? options : options && options.signal;
  return isAbortSignal(candidate) ? candidate : null;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw cancellationError();
  }
}

async function awaitWithSignal(value, signal) {
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

function cancelReader(reader) {
  if (!reader || typeof reader.cancel !== 'function') {
    return;
  }
  try {
    const cancellation = reader.cancel();
    if (cancellation && typeof cancellation.catch === 'function') {
      cancellation.catch(() => {});
    }
  } catch {
    // Cancelling a malformed or already-closed body must not mask the safe error.
  }
}

function cancelResponseBody(response) {
  const body = response && response.body;
  if (body && typeof body.cancel === 'function') {
    try {
      const cancellation = body.cancel();
      if (cancellation && typeof cancellation.catch === 'function') {
        cancellation.catch(() => {});
      }
    } catch {
      // A failed cancellation is harmless; no response content is surfaced.
    }
  }
}

async function readResponseText(response, maxResponseBytes, signal) {
  throwIfAborted(signal);
  parseContentLength(response, maxResponseBytes);

  const body = response && response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let totalLength = 0;
    let completed = false;
    try {
      while (true) {
        const { done, value } = await awaitWithSignal(reader.read(), signal);
        if (done) {
          completed = true;
          break;
        }
        const chunk = asUint8Array(value);
        if (!chunk) {
          throw new ShadertoyApiError(
            'invalid_response',
            'The Shadertoy API returned an unsupported response body.',
            { retryable: false },
          );
        }
        totalLength += chunk.byteLength;
        if (totalLength > maxResponseBytes) {
          cancelReader(reader);
          throw new ShadertoyApiError(
            'response_too_large',
            'The Shadertoy API response exceeded the configured size limit.',
            { retryable: false },
          );
        }
        chunks.push(chunk);
      }
    } finally {
      if (!completed) {
        cancelReader(reader);
      }
      if (typeof reader.releaseLock === 'function') {
        try {
          reader.releaseLock();
        } catch {
          // A malformed stream must not prevent timeout/cancellation cleanup.
        }
      }
    }
    return new TextDecoder('utf-8').decode(concatChunks(chunks, totalLength));
  }

  try {
    if (response && typeof response.arrayBuffer === 'function') {
      const buffer = await awaitWithSignal(response.arrayBuffer(), signal);
      const bytes = asUint8Array(buffer);
      if (!bytes || bytes.byteLength > maxResponseBytes) {
        throw new ShadertoyApiError(
          'response_too_large',
          'The Shadertoy API response exceeded the configured size limit.',
          { retryable: false },
        );
      }
      return new TextDecoder('utf-8').decode(bytes);
    }

    if (response && typeof response.text === 'function') {
      const text = await awaitWithSignal(response.text(), signal);
      if (typeof text !== 'string' || utf8ByteLength(text) > maxResponseBytes) {
        throw new ShadertoyApiError(
          'response_too_large',
          'The Shadertoy API response exceeded the configured size limit.',
          { retryable: false },
        );
      }
      return text;
    }

    if (response && typeof response.json === 'function') {
      const value = await awaitWithSignal(response.json(), signal);
      const text = JSON.stringify(value);
      if (utf8ByteLength(text) > maxResponseBytes) {
        throw new ShadertoyApiError(
          'response_too_large',
          'The Shadertoy API response exceeded the configured size limit.',
          { retryable: false },
        );
      }
      return text;
    }
  } catch (error) {
    cancelResponseBody(response);
    throw error;
  }

  throw new ShadertoyApiError(
    'invalid_response',
    'The Shadertoy API returned no readable response body.',
    { retryable: false },
  );
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ShadertoyApiError(
      'invalid_json',
      'The Shadertoy API returned invalid JSON.',
      { retryable: false },
    );
  }
}

function parseRetryAfter(headerValue, now, maxDelayMs) {
  if (headerValue == null) {
    return null;
  }

  const value = String(headerValue).trim();
  if (!value) {
    return null;
  }

  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return Math.min(Math.round(Number(value) * 1_000), maxDelayMs);
  }

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) {
    return null;
  }
  return Math.min(Math.max(0, retryAt - now()), maxDelayMs);
}

function makeHttpError(status, retryAfterMs) {
  if (status === 429) {
    return new ShadertoyApiError(
      'rate_limited',
      'The Shadertoy API rate limit was reached.',
      { status, retryAfterMs, retryable: true },
    );
  }
  if (status === 401 || status === 403) {
    return new ShadertoyApiError(
      'api_auth_failed',
      'The Shadertoy API rejected the configured credentials.',
      { status, retryable: false },
    );
  }
  if (status >= 500 && status <= 599) {
    return new ShadertoyApiError(
      'server_error',
      'The Shadertoy API is temporarily unavailable.',
      { status, retryable: true },
    );
  }
  return new ShadertoyApiError(
    'http_error',
    'The Shadertoy API returned an unexpected HTTP status.',
    { status, retryable: false },
  );
}

function withAttempts(error, attempts) {
  if (error instanceof ShadertoyApiError) {
    error.attempts = attempts;
  }
  return error;
}

const SAFE_ERROR_MESSAGES = {
  api_auth_failed: 'The Shadertoy API rejected the configured credentials.',
  cancelled: 'The Shadertoy API request was cancelled.',
  fetch_unavailable: 'No fetch implementation is available for the Shadertoy API client.',
  http_error: 'The Shadertoy API returned an unexpected HTTP status.',
  invalid_json: 'The Shadertoy API returned invalid JSON.',
  invalid_response: 'The Shadertoy API returned an invalid response.',
  network_error: 'The request to the Shadertoy API failed.',
  rate_limited: 'The Shadertoy API rate limit was reached.',
  response_too_large: 'The Shadertoy API response exceeded the configured size limit.',
  server_error: 'The Shadertoy API is temporarily unavailable.',
  timeout: 'The Shadertoy API request timed out.',
};

function asShadertoyApiError(error) {
  const code = error instanceof ShadertoyApiError
    && Object.prototype.hasOwnProperty.call(SAFE_ERROR_MESSAGES, error.code)
    ? error.code
    : 'network_error';
  return new ShadertoyApiError(
    code,
    SAFE_ERROR_MESSAGES[code],
    {
      status: error instanceof ShadertoyApiError ? error.status : null,
      retryAfterMs: error instanceof ShadertoyApiError ? error.retryAfterMs : null,
      retryable: error instanceof ShadertoyApiError ? error.retryable : true,
    },
  );
}

/**
 * Parses a direct Shadertoy id or an exact canonical Shadertoy view URL.
 * Returning null (rather than attempting to repair input) keeps IDs safe for
 * the official API path.
 */
export function parseShaderId(value) {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  if (SHADER_ID_PATTERN.test(value)) {
    return value;
  }

  if (value !== value.trim()) {
    return null;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.shadertoy.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  const match = /^\/view\/([A-Za-z0-9]{6})$/.exec(url.pathname);
  return match ? match[1] : null;
}

export class ShadertoyApiError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ShadertoyApiError';
    this.code = code;
    this.status = Number.isInteger(options.status) ? options.status : null;
    this.retryAfterMs = Number.isFinite(options.retryAfterMs)
      ? Math.max(0, Math.floor(options.retryAfterMs))
      : null;
    this.retryable = Boolean(options.retryable);
    this.attempts = Number.isInteger(options.attempts) ? options.attempts : null;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      retryAfterMs: this.retryAfterMs,
      retryable: this.retryable,
      attempts: this.attempts,
    };
  }
}

/**
 * A deliberately narrow client for Shadertoy's documented public API.
 * It never accepts a custom origin or arbitrary request path.
 */
export class ShadertoyApiClient {
  #apiKey;
  #fetch;
  #timeoutMs;
  #maxResponseBytes;
  #maxRetries;
  #retryBaseMs;
  #maxRetryDelayMs;
  #ratePerSecond;
  #minimumRequestIntervalMs;
  #userAgent;
  #sleep;
  #now;
  #setTimeout;
  #clearTimeout;
  #AbortController;
  #rateTail = Promise.resolve();
  #nextRequestAt = 0;

  constructor(options = {}) {
    const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
    this.#apiKey = apiKey || null;
    this.#fetch = typeof options.fetch === 'function'
      ? options.fetch
      : typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : null;
    this.#timeoutMs = Math.floor(asPositiveFiniteNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS));
    this.#maxResponseBytes = Math.floor(
      asPositiveFiniteNumber(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES),
    );
    this.#maxRetries = Math.min(
      asNonNegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES),
      MAX_RETRIES,
    );
    this.#retryBaseMs = Math.floor(asPositiveFiniteNumber(options.retryBaseMs, DEFAULT_RETRY_BASE_MS));
    this.#maxRetryDelayMs = Math.floor(
      asPositiveFiniteNumber(options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS),
    );
    this.#ratePerSecond = Math.min(
      asPositiveFiniteNumber(options.ratePerSecond, DEFAULT_RATE_PER_SECOND),
      MAX_RATE_PER_SECOND,
    );
    this.#minimumRequestIntervalMs = 1_000 / this.#ratePerSecond;

    const requestedUserAgent = typeof options.userAgent === 'string' ? options.userAgent.trim() : '';
    this.#userAgent = requestedUserAgent.includes(REQUIRED_USER_AGENT_NOTE)
      ? requestedUserAgent
      : `${requestedUserAgent || 'shadertoy-netease-mcp'} (${REQUIRED_USER_AGENT_NOTE})`;

    this.#sleep = typeof options.sleep === 'function'
      ? options.sleep
      : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    this.#now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.#setTimeout = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
    this.#clearTimeout = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
    this.#AbortController = options.AbortController || globalThis.AbortController || null;
  }

  get hasApiKey() {
    return Boolean(this.#apiKey);
  }

  get ratePerSecond() {
    return this.#ratePerSecond;
  }

  async listAllShaderIds(options = {}) {
    const signal = signalFromOptions(options);
    const payload = await this.#requestJson(null, signal);
    const values = payload && typeof payload === 'object'
      ? Array.isArray(payload.Shaders)
        ? payload.Shaders
        : Array.isArray(payload.Results)
          ? payload.Results
          : null
      : null;
    if (!values) {
      throw new ShadertoyApiError(
        'schema_error',
        'The Shadertoy API returned an unknown shader list schema.',
        { retryable: false },
      );
    }

    const ids = [];
    const seen = new Set();
    for (const value of values) {
      const id = parseShaderId(value);
      if (!id) {
        throw new ShadertoyApiError(
          'invalid_shader_id',
          'The Shadertoy API returned an invalid shader id.',
          { retryable: false },
        );
      }
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }

  async getShader(value, options = {}) {
    const signal = signalFromOptions(options);
    throwIfAborted(signal);
    const shaderId = parseShaderId(value);
    if (!shaderId) {
      throw new ShadertoyApiError(
        'invalid_shader_id',
        'A valid six-character Shadertoy id is required.',
        { retryable: false },
      );
    }

    const payload = await this.#requestJson(shaderId, signal);
    throwIfAborted(signal);
    if (!payload || typeof payload !== 'object' || !payload.Shader || typeof payload.Shader !== 'object') {
      throw new ShadertoyApiError(
        'invalid_response',
        'The Shadertoy API returned no shader payload.',
        { retryable: false },
      );
    }
    return payload;
  }

  async #requestJson(shaderId, signal) {
    if (!this.#apiKey) {
      throw new ShadertoyApiError(
        'auth_required',
        'A Shadertoy API key is required.',
        { retryable: false },
      );
    }
    if (!this.#fetch) {
      throw new ShadertoyApiError(
        'fetch_unavailable',
        'No fetch implementation is available for the Shadertoy API client.',
        { retryable: false },
      );
    }

    const url = new URL(
      shaderId ? `${SHADERTOY_API_PATH}/${shaderId}` : SHADERTOY_API_PATH,
      SHADERTOY_ORIGIN,
    );
    url.searchParams.set('key', this.#apiKey);

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      try {
        throwIfAborted(signal);
        await this.#reserveRateSlot(signal);
        return await this.#fetchJsonOnce(url.toString(), signal);
      } catch (error) {
        const apiError = asShadertoyApiError(error);
        if (!apiError.retryable || attempt >= this.#maxRetries) {
          throw withAttempts(apiError, attempt + 1);
        }
        await this.#sleepForRetry(apiError, attempt, signal);
        continue;
      }
    }

    throw new ShadertoyApiError(
      'request_failed',
      'The Shadertoy API request could not be completed.',
      { retryable: false },
    );
  }

  async #fetchJsonOnce(url, signal) {
    throwIfAborted(signal);
    const AbortControllerClass = this.#AbortController;
    let controller = null;
    if (AbortControllerClass) {
      try {
        controller = new AbortControllerClass();
      } catch {
        controller = null;
      }
    }

    const requestSignal = controller ? controller.signal : signal;
    let detachExternalAbort = () => {};
    if (controller && signal) {
      const abortFromCaller = () => controller.abort();
      signal.addEventListener('abort', abortFromCaller, { once: true });
      detachExternalAbort = () => signal.removeEventListener('abort', abortFromCaller);
    }

    let timedOut = false;
    let timer;
    const timeoutError = new ShadertoyApiError(
      'timeout',
      'The Shadertoy API request timed out.',
      { retryable: true },
    );
    const timeout = new Promise((_, reject) => {
      timer = this.#setTimeout(() => {
        timedOut = true;
        if (controller) {
          controller.abort();
        }
        reject(timeoutError);
      }, this.#timeoutMs);
    });

    let response = null;
    try {
      const requestInit = {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': this.#userAgent,
        },
        // Do not follow a redirect that could forward the query-string key.
        redirect: 'manual',
      };
      if (requestSignal) {
        requestInit.signal = requestSignal;
      }
      response = await Promise.race([
        awaitWithSignal(Promise.resolve().then(() => this.#fetch(url, requestInit)), signal),
        timeout,
      ]);
      if (!response || typeof response !== 'object') {
        throw new ShadertoyApiError(
          'invalid_response',
          'The Shadertoy API returned an invalid response object.',
          { retryable: false },
        );
      }
      parseContentLength(response, this.#maxResponseBytes);
      const status = Number(response.status);
      if (!isSuccessfulStatus(status)) {
        cancelResponseBody(response);
        const retryAfterMs = status === 429
          ? parseRetryAfter(
            readHeader(response.headers, 'retry-after'),
            this.#now,
            this.#maxRetryDelayMs,
          )
          : null;
        throw makeHttpError(status, retryAfterMs);
      }

      const text = await Promise.race([
        awaitWithSignal(
          readResponseText(response, this.#maxResponseBytes, requestSignal),
          signal,
        ),
        timeout,
      ]);
      throwIfAborted(signal);
      return parseJsonResponse(text);
    } catch (error) {
      if (timedOut) {
        cancelResponseBody(response);
        throw timeoutError;
      }
      if (signal && signal.aborted) {
        cancelResponseBody(response);
        throw cancellationError();
      }
      if (error instanceof ShadertoyApiError) {
        throw error;
      }
      throw new ShadertoyApiError(
        'network_error',
        'The request to the Shadertoy API failed.',
        { retryable: true },
      );
    } finally {
      this.#clearTimeout(timer);
      detachExternalAbort();
    }
  }

  async #reserveRateSlot(signal) {
    let release;
    const previous = this.#rateTail;
    this.#rateTail = new Promise((resolve) => {
      release = resolve;
    });
    let previousCompleted = false;

    try {
      await awaitWithSignal(previous, signal);
      previousCompleted = true;
      throwIfAborted(signal);
      const now = Number(this.#now());
      const currentTime = Number.isFinite(now) ? now : Date.now();
      const slotAt = Math.max(currentTime, this.#nextRequestAt);
      const delayMs = slotAt - currentTime;
      if (delayMs > 0) {
        await awaitWithSignal(this.#sleep(delayMs), signal);
      }
      throwIfAborted(signal);
      this.#nextRequestAt = slotAt + this.#minimumRequestIntervalMs;
    } finally {
      if (previousCompleted) {
        release();
      } else {
        Promise.resolve(previous).then(release, release);
      }
    }
  }

  async #sleepForRetry(error, attempt, signal) {
    const exponentialDelay = Math.min(
      this.#retryBaseMs * (2 ** attempt),
      this.#maxRetryDelayMs,
    );
    const delayMs = error.retryAfterMs == null
      ? exponentialDelay
      : Math.min(error.retryAfterMs, this.#maxRetryDelayMs);
    if (delayMs > 0) {
      await awaitWithSignal(this.#sleep(delayMs), signal);
    }
  }
}
