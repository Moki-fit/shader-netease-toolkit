import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseShaderId,
  ShadertoyApiClient,
  ShadertoyApiError,
} from '../src/shadertoy-api.mjs';
import { normalizeApiProject, syncCatalog, syncStep } from '../src/catalog.mjs';
import { LibraryStore } from '../src/db.mjs';

function jsonResponse(value, options = {}) {
  return new Response(JSON.stringify(value), {
    status: options.status || 200,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

function makeNoWaitClient(options = {}) {
  const delays = [];
  const client = new ShadertoyApiClient({
    apiKey: 'not-returned-from-client',
    ratePerSecond: 2,
    now: () => 0,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
    ...options,
  });
  return { client, delays };
}

function shaderPayload(id, code = 'void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }') {
  return {
    Shader: {
      info: {
        id,
        name: `Shader ${id}`,
        username: 'tester',
        description: 'A test shader',
        tags: ['test'],
      },
      renderpass: [{ type: 'image', code, inputs: [], outputs: [] }],
    },
  };
}

test('parseShaderId accepts only a strict id or canonical view URL', () => {
  assert.equal(parseShaderId('XslGz8'), 'XslGz8');
  assert.equal(parseShaderId('https://www.shadertoy.com/view/XslGz8'), 'XslGz8');
  assert.equal(parseShaderId(' XslGz8'), null);
  assert.equal(parseShaderId('https://www.shadertoy.com/view/XslGz8?x=1'), null);
  assert.equal(parseShaderId('https://example.com/view/XslGz8'), null);
  assert.equal(parseShaderId('../XslGz8'), null);
});

test('the API client requires a key without calling fetch', async () => {
  let called = false;
  const client = new ShadertoyApiClient({
    fetch: async () => {
      called = true;
      return jsonResponse({ Shaders: [] });
    },
  });

  await assert.rejects(
    () => client.listAllShaderIds(),
    (error) => error instanceof ShadertoyApiError && error.code === 'auth_required' && !error.message.includes('key='),
  );
  assert.equal(called, false);
  assert.equal(client.hasApiKey, false);
});

test('the client uses only the official endpoint and identifies API use', async () => {
  const requests = [];
  const { client } = makeNoWaitClient({
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (new URL(url).pathname.endsWith('/XslGz8')) {
        return jsonResponse(shaderPayload('XslGz8'));
      }
      return jsonResponse({ Shaders: ['XslGz8'] });
    },
  });

  assert.deepEqual(await client.listAllShaderIds(), ['XslGz8']);
  assert.deepEqual(await client.getShader('XslGz8'), shaderPayload('XslGz8'));
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://www.shadertoy.com');
    assert.match(url.pathname, /^\/api\/v1\/shaders(?:\/XslGz8)?$/);
    assert.equal(url.searchParams.get('key'), 'not-returned-from-client');
    assert.match(request.init.headers['User-Agent'], /uses Shadertoy\.com API/);
    assert.equal(request.init.redirect, 'manual');
  }
  await assert.rejects(
    () => client.getShader('XslGz8/../../not-a-shader'),
    (error) => error instanceof ShadertoyApiError && error.code === 'invalid_shader_id',
  );
});

test('the client accepts strict Shaders or Results id arrays and rejects unknown schemas', async () => {
  const responses = [
    jsonResponse({ Results: ['XslGz8', 'MslGWN'] }),
    jsonResponse({ items: ['XslGz8'] }),
  ];
  const { client } = makeNoWaitClient({
    maxRetries: 0,
    fetch: async () => responses.shift(),
  });

  assert.deepEqual(await client.listAllShaderIds(), ['XslGz8', 'MslGWN']);
  await assert.rejects(
    () => client.listAllShaderIds(),
    (error) => error instanceof ShadertoyApiError && error.code === 'schema_error',
  );
});

test('429 Retry-After and 5xx responses have bounded retries', async () => {
  const responses = [
    new Response('', { status: 500 }),
    new Response('', { status: 429, headers: { 'retry-after': '1' } }),
    jsonResponse({ Shaders: ['XslGz8'] }),
  ];
  let calls = 0;
  const { client, delays } = makeNoWaitClient({
    maxRetries: 2,
    retryBaseMs: 5,
    fetch: async () => {
      calls += 1;
      return responses.shift();
    },
  });

  assert.deepEqual(await client.listAllShaderIds(), ['XslGz8']);
  assert.equal(calls, 3);
  assert.ok(delays.includes(5));
  assert.ok(delays.includes(1_000));
});

test('the client rejects a response that exceeds its configured byte limit', async () => {
  const { client } = makeNoWaitClient({
    maxResponseBytes: 16,
    fetch: async () => jsonResponse({ Shaders: ['XslGz8', 'MslGWN'] }),
  });

  await assert.rejects(
    () => client.listAllShaderIds(),
    (error) => error instanceof ShadertoyApiError && error.code === 'response_too_large',
  );
});

test('a redirect is not followed and a timeout aborts a non-responsive fetch', async () => {
  let redirectInit;
  const { client: redirectClient } = makeNoWaitClient({
    maxRetries: 0,
    fetch: async (_url, init) => {
      redirectInit = init;
      return new Response('', {
        status: 302,
        headers: { location: 'https://untrusted.example.invalid/collect' },
      });
    },
  });
  await assert.rejects(
    () => redirectClient.listAllShaderIds(),
    (error) => error instanceof ShadertoyApiError && error.code === 'http_error' && error.status === 302,
  );
  assert.equal(redirectInit.redirect, 'manual');

  let receivedSignal;
  const { client: timeoutClient } = makeNoWaitClient({
    maxRetries: 0,
    timeoutMs: 5,
    fetch: async (_url, init) => {
      receivedSignal = init.signal;
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    () => timeoutClient.listAllShaderIds(),
    (error) => error instanceof ShadertoyApiError && error.code === 'timeout',
  );
  assert.equal(receivedSignal.aborted, true);
});

test('timeout covers a stalled response body reader and cancels it without hanging', async () => {
  let receivedSignal;
  let readerCancelled = false;
  const reader = {
    read() {
      return new Promise(() => {});
    },
    cancel() {
      readerCancelled = true;
      return Promise.resolve();
    },
    releaseLock() {},
  };
  const { client } = makeNoWaitClient({
    maxRetries: 0,
    timeoutMs: 5,
    fetch: async (_url, init) => {
      receivedSignal = init.signal;
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: {
          getReader() {
            return reader;
          },
        },
      };
    },
  });

  await assert.rejects(
    () => client.listAllShaderIds(),
    (error) => error instanceof ShadertoyApiError && error.code === 'timeout',
  );
  assert.equal(receivedSignal.aborted, true);
  assert.equal(readerCancelled, true);
});

test('caller abort cancels a stalled response body reader without hanging', async () => {
  const controller = new AbortController();
  let receivedSignal;
  let readerCancelled = false;
  const reader = {
    read() {
      return new Promise(() => {});
    },
    cancel() {
      readerCancelled = true;
      return Promise.resolve();
    },
    releaseLock() {},
  };
  const { client } = makeNoWaitClient({
    maxRetries: 0,
    timeoutMs: 1_000,
    fetch: async (_url, init) => {
      receivedSignal = init.signal;
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: {
          getReader() {
            return reader;
          },
        },
      };
    },
  });

  const request = client.listAllShaderIds({ signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(
    () => request,
    (error) => error instanceof ShadertoyApiError && error.code === 'cancelled',
  );
  assert.equal(receivedSignal.aborted, true);
  assert.equal(readerCancelled, true);
});

test('normalizeApiProject preserves multipass input/output metadata without downloading assets', () => {
  const payload = {
    Shader: {
      info: {
        id: 'XslGz8',
        name: 'Multi pass',
        username: 'tester',
        description: 'two passes',
        tags: ['buffer', 'buffer', 'image'],
        flags: 3,
        published: 1,
        date: 1_700_000_000,
        viewed: 7,
        likes: 2,
      },
      renderpass: [
        {
          type: 'buffer',
          name: 'Buffer A',
          code: 'buffer code',
          inputs: [{ channel: 0, ctype: 'texture', src: '/media/a.png' }],
          outputs: [{ channel: 0, id: '4dXGR8' }],
        },
        {
          type: 'image',
          code: 'image code',
          inputs: [{ channel: 0, ctype: 'buffer', id: '4dXGR8' }],
          outputs: [],
        },
      ],
    },
  };

  const project = normalizeApiProject(payload, { fetchedAt: '2026-09-02T00:00:00.000Z' });
  assert.equal(project.id, 'XslGz8');
  assert.equal(project.renderpasses.length, 2);
  assert.equal(project.renderpass, project.renderpasses);
  assert.equal(project.renderpasses[0].inputs[0].src, '/media/a.png');
  assert.equal(project.renderpasses[0].outputs[0].id, '4dXGR8');
  assert.deepEqual(project.tags, ['buffer', 'image']);
  assert.deepEqual(project.remoteMetadata, { flags: 3, published: 1 });
  assert.equal(project.fetchedAt, '2026-09-02T00:00:00.000Z');
  assert.deepEqual(project.rawPayload, payload);
  assert.notEqual(project.rawPayload, payload);
});

test('syncCatalog returns structured auth_required without opening a store run', async () => {
  let started = false;
  const store = {
    async beginSync() {
      started = true;
      return 'run-1';
    },
  };
  const client = new ShadertoyApiClient({ apiKey: '' });

  const result = await syncCatalog(store, client);
  assert.equal(result.status, 'auth_required');
  assert.equal(result.error.code, 'auth_required');
  assert.equal(started, false);
});

test('syncStep bounds project fetches and records each normalized project', async () => {
  const calls = {
    begin: [],
    list: [],
    finish: [],
    upserts: [],
    errors: [],
    fetched: [],
  };
  const store = {
    async beginSync(kind) {
      calls.begin.push(kind);
      return 'fetch-run';
    },
    async finishSync(runId, result) {
      calls.finish.push({ runId, result });
    },
    async listPending(options) {
      calls.list.push(options);
      return ['XslGz8', 'MslGWN', '4dXGR8'];
    },
    async markFetchError(id, error) {
      calls.errors.push({ id, error });
    },
    async upsertProject(project, options) {
      calls.upserts.push({ project, options });
    },
  };
  const client = {
    hasApiKey: true,
    async getShader(id) {
      calls.fetched.push(id);
      return shaderPayload(id);
    },
  };

  const result = await syncStep(store, client, {
    limit: 2,
    force: true,
    staleBefore: '2026-09-01T00:00:00.000Z',
    fetchedAt: '2026-09-02T00:00:00.000Z',
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.resumable, true);
  assert.deepEqual(result.progress, {
    pending: 3,
    scanned: 3,
    scanLimit: 3,
    terminalSkipped: 0,
    selected: 2,
    processed: 2,
    remaining: 1,
    remainingExact: false,
    retryableFailures: 0,
    terminalFailures: 0,
    hasMore: true,
    timeLimited: false,
  });
  assert.deepEqual(calls.begin, ['fetch']);
  assert.deepEqual(calls.fetched, ['XslGz8', 'MslGWN']);
  assert.equal(calls.upserts.length, 2);
  assert.deepEqual(calls.upserts[0].options, { syncRunId: 'fetch-run' });
  assert.deepEqual(calls.list, [{
    limit: 3,
    force: true,
    staleBefore: '2026-09-01T00:00:00.000Z',
  }]);
  assert.equal(calls.errors.length, 0);
  assert.equal(calls.finish[0].result.status, 'partial');
});

test('syncStep respects maxDurationMs before starting the next fetch and remains resumable', async () => {
  let time = 0;
  const fetched = [];
  const store = {
    async beginSync() {
      return 'timed-run';
    },
    async finishSync() {},
    async listPending() {
      return ['XslGz8', 'MslGWN', '4dXGR8'];
    },
    async markFetchError() {},
    async upsertProject() {},
  };
  const client = {
    hasApiKey: true,
    async getShader(id) {
      fetched.push(id);
      time += 10;
      return shaderPayload(id);
    },
  };

  const result = await syncStep(store, client, {
    limit: 3,
    maxDurationMs: 10,
    now: () => time,
  });

  assert.deepEqual(fetched, ['XslGz8']);
  assert.equal(result.status, 'partial');
  assert.equal(result.resumable, true);
  assert.deepEqual(result.progress, {
    pending: 3,
    scanned: 3,
    scanLimit: 4,
    terminalSkipped: 0,
    selected: 3,
    processed: 1,
    remaining: 2,
    remainingExact: true,
    retryableFailures: 0,
    terminalFailures: 0,
    hasMore: false,
    timeLimited: true,
  });
});

test('real LibraryStore pagination keeps a three-item queue resumable at limit two', async () => {
  const store = new LibraryStore(':memory:');
  const fetched = [];
  const client = {
    hasApiKey: true,
    async getShader(id) {
      fetched.push(id);
      return shaderPayload(id);
    },
  };
  try {
    store.markCatalog(['XslGz8', 'MslGWN', '4dXGR8']);

    const first = await syncStep(store, client, { limit: 2 });
    assert.equal(first.status, 'partial');
    assert.equal(first.resumable, true);
    assert.equal(first.progress.remaining, 1);
    assert.equal(first.progress.remainingExact, false);
    assert.equal(store.status().counts.pending, 1);

    const second = await syncStep(store, client, { limit: 2 });
    assert.equal(second.status, 'success');
    assert.equal(second.resumable, false);
    assert.equal(second.progress.remaining, 0);
    assert.equal(second.progress.remainingExact, true);
    assert.equal(store.status().counts.pending, 0);
    assert.deepEqual(fetched, ['4dXGR8', 'MslGWN', 'XslGz8']);
  } finally {
    store.close();
  }
});

test('a permanent 404 is persisted as terminal and does not block the next queued shader', async () => {
  const store = new LibraryStore(':memory:');
  const fetched = [];
  const client = {
    hasApiKey: true,
    async getShader(id) {
      fetched.push(id);
      if (id === '4dXGR8') {
        throw new ShadertoyApiError(
          'http_error',
          'not exposed',
          { status: 404, retryable: false },
        );
      }
      return shaderPayload(id);
    },
  };
  try {
    store.markCatalog(['4dXGR8', 'MslGWN']);
    const first = await syncStep(store, client, { limit: 1 });
    assert.equal(first.status, 'partial');
    assert.equal(first.stats.terminalFailures, 1);
    assert.equal(store.countPending(), 1);
    assert.deepEqual(store.listPending().map((item) => item.id), ['MslGWN']);

    const second = await syncStep(store, client, { limit: 1 });
    assert.equal(second.resumable, false);
    assert.deepEqual(fetched, ['4dXGR8', 'MslGWN']);
    assert.equal(store.getProject('MslGWN').id, 'MslGWN');
    assert.equal(store.countPending(), 0);

    const third = await syncStep(store, client, { limit: 1 });
    assert.equal(third.resumable, false);
    assert.deepEqual(fetched, ['4dXGR8', 'MslGWN']);
  } finally {
    store.close();
  }
});

test('a later successful official catalog requeues a terminal id without making resume retry it first', async () => {
  const store = new LibraryStore(':memory:');
  const fetched = [];
  const client = {
    hasApiKey: true,
    async listAllShaderIds() {
      return ['4dXGR8'];
    },
    async getShader(id) {
      fetched.push(id);
      if (fetched.length === 1) {
        throw new ShadertoyApiError('http_error', 'not exposed', {
          status: 404,
          retryable: false,
        });
      }
      return shaderPayload(id);
    },
  };
  try {
    assert.equal((await syncCatalog(store, client)).status, 'success');
    const terminal = await syncStep(store, client, { limit: 1 });
    assert.equal(terminal.status, 'partial');
    assert.equal(terminal.stats.terminalFailures, 1);
    assert.deepEqual(fetched, ['4dXGR8']);
    assert.equal(store.countPending(), 0);

    // `--resume` maps to another fetch step without a catalog request, so a
    // durable terminal marker must not consume another upstream detail call.
    const resumed = await syncStep(store, client, { limit: 1 });
    assert.equal(resumed.status, 'success');
    assert.equal(resumed.resumable, false);
    assert.deepEqual(fetched, ['4dXGR8']);

    assert.equal((await syncCatalog(store, client)).status, 'success');
    assert.equal(store.countPending(), 1);
    assert.deepEqual(store.listPending().map((item) => ({
      id: item.id,
      fetchAttempts: item.fetchAttempts,
      fetchError: item.fetchError,
    })), [{ id: '4dXGR8', fetchAttempts: 0, fetchError: null }]);

    const recovered = await syncStep(store, client, { limit: 1 });
    assert.equal(recovered.status, 'success');
    assert.equal(recovered.resumable, false);
    assert.deepEqual(fetched, ['4dXGR8', '4dXGR8']);
    assert.equal(store.getProject('4dXGR8').id, '4dXGR8');

    // Repeating a successful catalog mark must not duplicate a fetched row or
    // downgrade it to pending.
    assert.equal((await syncCatalog(store, client)).status, 'success');
    assert.equal(store.status().counts.catalog, 1);
    assert.equal(store.countPending(), 0);
  } finally {
    store.close();
  }
});

test('a terminal fetch remains resumable when its terminal marker cannot be stored', async () => {
  const store = {
    async beginSync() {
      return 'terminal-write-run';
    },
    async finishSync() {},
    async listPending() {
      return ['XslGz8'];
    },
    async markFetchError() {},
    async markFetchTerminal() {
      throw new Error('database unavailable');
    },
    async upsertProject() {},
  };
  const client = {
    hasApiKey: true,
    async getShader() {
      throw new ShadertoyApiError('http_error', 'not exposed', {
        status: 404,
        retryable: false,
      });
    },
  };

  const result = await syncStep(store, client, { limit: 1 });
  assert.equal(result.status, 'partial');
  assert.equal(result.stats.terminalFailures, 1);
  assert.equal(result.stats.retryableFailures, 1);
  assert.equal(result.resumable, true);
});

test('syncStep returns on AbortSignal and ignores a later uncooperative fetch result', async () => {
  const controller = new AbortController();
  const calls = {
    finish: [],
    upserts: 0,
    errors: 0,
    receivedSignal: null,
  };
  let fetchStarted;
  let resolveFetch;
  const fetchedPayload = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const store = {
    async beginSync() {
      return 'cancel-run';
    },
    async finishSync(runId, result) {
      calls.finish.push({ runId, result });
    },
    async listPending() {
      return ['XslGz8'];
    },
    async markFetchError() {
      calls.errors += 1;
    },
    async upsertProject() {
      calls.upserts += 1;
    },
  };
  const client = {
    hasApiKey: true,
    async getShader(_id, options) {
      calls.receivedSignal = options.signal;
      fetchStarted();
      return fetchedPayload;
    },
  };

  const operation = syncStep(store, client, { limit: 1, signal: controller.signal });
  await new Promise((resolve) => {
    fetchStarted = resolve;
  });
  controller.abort();
  const result = await operation;

  assert.equal(result.status, 'cancelled');
  assert.equal(result.error.code, 'cancelled');
  assert.equal(result.resumable, true);
  assert.equal(calls.receivedSignal, controller.signal);
  assert.equal(calls.upserts, 0);
  assert.equal(calls.errors, 0);
  assert.deepEqual(calls.finish, [{
    runId: 'cancel-run',
    result: {
      status: 'cancelled',
      stats: result.stats,
      error: result.error,
    },
  }]);

  resolveFetch(shaderPayload('XslGz8'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.upserts, 0);
  assert.equal(calls.errors, 0);
});
