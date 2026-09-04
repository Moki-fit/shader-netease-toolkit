import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { runCli } from '../src/cli.mjs';
import { McpStdioServer, MCP_PROTOCOL_VERSION, MCP_TRANSPORT_LIMITS } from '../src/mcp-server.mjs';
import { TOOL_DEFINITIONS, createToolRegistry } from '../src/tools.mjs';

function makeRuntime(overrides = {}) {
  const projects = new Map([
    ['Xds3zN', {
      id: 'Xds3zN',
      title: 'Test pass',
      author: 'Example author',
      license: 'CC BY-NC-SA 3.0',
      passes: [{ name: 'Image', code: 'void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }' }],
    }],
  ]);
  return {
    apiKey: '',
    store: {
      status() {
        return { projectCount: projects.size, databasePath: 'must-not-be-exposed.sqlite' };
      },
      search(query) {
        return [...projects.values()].filter((project) => project.title.toLowerCase().includes(query.toLowerCase()));
      },
      getProject(id) {
        return projects.get(id) || null;
      },
      upsertProject(project) {
        projects.set(project.id, project);
        return { id: project.id, created: true };
      },
    },
    analyzer: {
      analyzeShadertoySource(source, { target }) {
        return { target, source, findings: ['mainImage'] };
      },
      rankNeteaseCandidates(candidates) {
        return candidates.map((candidate, index) => ({ id: candidate.id, rank: index + 1 }));
      },
    },
    ...overrides,
  };
}

async function runLines(lines, registry) {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  let stdout = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    stdout += chunk;
  });
  const server = new McpStdioServer({ input, output, error, registry });
  const finished = server.start();
  input.end(lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
  await finished;
  return stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function runServerProcess(lines, options = {}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'shadertoy-netease-mcp-'));
  const dataDir = options.dataDir || temporaryRoot;
  const serverPath = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url));
  try {
    const child = spawn(process.execPath, [serverPath], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        SHADERTOY_DATA_DIR: dataDir,
        SHADERTOY_API_KEY: options.apiKey || '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { exitCode, stdout, stderr, dataDir, temporaryRoot };
  } finally {
    if (options.cleanup !== false) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

async function runChunks(chunks, registry) {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  let stdout = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    stdout += chunk;
  });
  const server = new McpStdioServer({ input, output, error, registry });
  const finished = server.start();
  for (const chunk of chunks.slice(0, -1)) {
    input.write(chunk);
  }
  input.end(chunks[chunks.length - 1]);
  await finished;
  return stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('stdio handshake, list, and local status produce only line-delimited JSON-RPC', async () => {
  const registry = createToolRegistry(makeRuntime());
  const messages = await runLines([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'shadertoy_library_status', arguments: {} } },
  ], registry);

  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((message) => message.id), [1, 2, 3]);
  assert.equal(messages[0].result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.deepEqual(messages[1].result.tools.map((tool) => tool.name), TOOL_DEFINITIONS.map((tool) => tool.name));
  assert.equal(messages[2].result.structuredContent.status, 'ok');
  assert.equal(messages[2].result.structuredContent.auth.status, 'auth_required');
  assert.equal('databasePath' in messages[2].result.structuredContent.library, false);
  for (const message of messages) {
    assert.equal(message.jsonrpc, '2.0');
  }
});

test('MCP accepts standard RequestParams metadata without passing it to tools', async () => {
  const calls = [];
  const registry = {
    list() {
      return [];
    },
    has(name) {
      return name === 'shadertoy_library_status';
    },
    async call(name, args) {
      calls.push({ name, args });
      return { content: [], structuredContent: { status: 'ok' } };
    },
  };
  const messages = await runLines([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Codex', version: '0.146.0' },
        _meta: { progressToken: 'initialize-progress' },
      },
    },
    { jsonrpc: '2.0', id: 2, method: 'ping', params: { _meta: { progressToken: 2 } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { 'io.codex/request': true } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: { 'io.codex/ready': true } } },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'shadertoy_library_status',
        arguments: {},
        _meta: { progressToken: 'status-progress', 'io.codex/call': { opaque: true } },
      },
    },
  ], registry);

  assert.deepEqual(messages.map((message) => message.id), [1, 2, 3, 4]);
  assert.equal(messages[3].result.structuredContent.status, 'ok');
  assert.deepEqual(calls, [{ name: 'shadertoy_library_status', args: {} }]);
});

test('MCP rejects malformed metadata and unknown request parameters', async () => {
  const registry = createToolRegistry(makeRuntime());
  const messages = await runLines([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'shadertoy_library_status', arguments: {}, _meta: [] },
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'shadertoy_library_status', arguments: {}, unsupported: true },
    },
    { jsonrpc: '2.0', id: 3, method: 'ping', params: { unsupported: true } },
    { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: null } },
  ], registry);

  for (const message of messages) {
    assert.equal(message.error.code, -32602);
  }
  assert.match(messages[0].error.message, /_meta must be an object/i);
  assert.deepEqual(messages[1].error.data, { properties: ['unsupported'] });
  assert.deepEqual(messages[2].error.data, { properties: ['unsupported'] });
  assert.match(messages[3].error.message, /_meta must be an object/i);
});

test('MCP returns protocol error codes for invalid JSON and invalid bounded tool input', async () => {
  const registry = createToolRegistry(makeRuntime());
  const messages = await runLines([
    '{not json',
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'sync_shadertoy_catalog_step',
        arguments: { limit: 11 },
      },
    },
  ], registry);

  assert.deepEqual(messages[0].error, { code: -32700, message: 'Parse error.' });
  assert.equal(messages[1].error.code, -32602);
});

test('MCP negotiates its implemented version and separates invalid requests, methods, and parameters', async () => {
  const registry = createToolRegistry(makeRuntime());
  const messages = await runLines([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'not_a_real_tool', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: [] },
    { jsonrpc: '2.0', id: 4, method: 'no/such/method' },
    { jsonrpc: '1.0', id: 5, method: 'ping' },
  ], registry);

  assert.equal(messages[0].result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(messages[1].error.code, -32602);
  assert.equal(messages[2].error.code, -32602);
  assert.equal(messages[3].error.code, -32601);
  assert.equal(messages[4].error.code, -32600);
});

test('get-project schema links explicit source windows to include_source=true', () => {
  const getProject = TOOL_DEFINITIONS.find((tool) => tool.name === 'get_shadertoy_project');
  assert.ok(getProject);
  assert.equal(getProject.inputSchema.properties.include_source.type, 'boolean');
  assert.equal(getProject.inputSchema.oneOf.length, 2);
  assert.deepEqual(getProject.inputSchema.oneOf[1].required, ['include_source', 'pass_index', 'source_offset', 'max_chars']);
});

test('chunk-level framing rejects a continuous oversized line without preventing the next request', async () => {
  const registry = {
    list: () => [],
    has: () => true,
    async call() {
      return { content: [], structuredContent: { status: 'ok' } };
    },
  };
  const oversized = Buffer.alloc(MCP_TRANSPORT_LIMITS.maxRequestBytes + 1, 0x61);
  const messages = await runChunks([
    oversized,
    Buffer.from(`\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`, 'utf8'),
  ], registry);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].error.code, -32600);
  assert.deepEqual(messages[1], { jsonrpc: '2.0', id: 2, result: {} });
});

test('stdio handling pauses at each request instead of running later requests concurrently', async () => {
  let releaseFirst;
  let signalFirstStarted;
  const firstStarted = new Promise((resolve) => { signalFirstStarted = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const starts = [];
  const registry = {
    list: () => [],
    has: () => true,
    async call(_name, args) {
      starts.push(args.order);
      if (args.order === 1) {
        signalFirstStarted();
        await firstRelease;
      }
      return { content: [], structuredContent: { status: 'ok', order: args.order } };
    },
  };
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new McpStdioServer({ input, output, error: new PassThrough(), registry });
  let stdout = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { stdout += chunk; });
  const finished = server.start();
  input.write([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'first', arguments: { order: 1 } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'second', arguments: { order: 2 } } }),
  ].join('\n') + '\n');
  await firstStarted;
  assert.deepEqual(starts, [1]);
  releaseFirst();
  input.end();
  await finished;
  assert.deepEqual(starts, [1, 2]);
  assert.deepEqual(stdout.trim().split('\n').map((line) => JSON.parse(line)).map((message) => message.id), [1, 2]);
});

test('MCP response budget falls back to a complete structured error rather than partial JSON', async () => {
  const enormous = 'x'.repeat(MCP_TRANSPORT_LIMITS.maxResponseBytes);
  const registry = {
    list: () => [],
    has: () => true,
    async call() {
      return {
        content: [{ type: 'text', text: enormous }],
        structuredContent: { status: 'ok', enormous },
      };
    },
  };
  const messages = await runLines([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'large', arguments: {} } },
  ], registry);
  const encoded = JSON.stringify(messages[0]);
  assert.ok(Buffer.byteLength(encoded, 'utf8') + 1 <= MCP_TRANSPORT_LIMITS.maxResponseBytes);
  assert.equal(messages[0].result.isError, true);
  assert.equal(messages[0].result.structuredContent.error.code, 'response_too_large');
});

test('real stdio child process emits only protocol JSON and no key-bearing stderr', async () => {
  const processResult = await runServerProcess([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'shadertoy_library_status', arguments: {} } },
  ]);

  assert.equal(processResult.exitCode, 0);
  assert.equal(processResult.stderr.includes('SHADERTOY_API_KEY'), false);
  const lines = processResult.stdout.trim().split('\n').filter(Boolean);
  const messages = lines.map((line) => JSON.parse(line));
  assert.equal(messages.length, 3);
  assert.equal(messages[0].result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(messages[1].result.tools.length, 7);
  assert.equal(messages[1].result.tools.find((tool) => tool.name === 'sync_shadertoy_catalog_step').inputSchema.properties.limit.default, 3);
  assert.equal(messages[2].result.structuredContent.auth.status, 'auth_required');
});

test('a real no-key child creates a missing nested data directory before serving status', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'shadertoy-netease-fresh-'));
  const dataDir = path.join(temporaryRoot, 'new', 'nested', 'library');
  try {
    const result = await runServerProcess([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shadertoy_library_status', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_shadertoy_library', arguments: { query: 'ocean' } } },
    ], { dataDir });
    const messages = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(result.exitCode, 0);
    assert.equal(messages[0].result.structuredContent.auth.status, 'auth_required');
    assert.deepEqual(messages[1].result.structuredContent.results, []);
    assert.equal((await stat(dataDir)).isDirectory(), true);
    assert.equal((await stat(path.join(dataDir, 'library.sqlite3'))).isFile(), true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('a nonempty API key never appears in real child output or local SQLite bytes', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'shadertoy-netease-key-'));
  const dataDir = path.join(temporaryRoot, 'library');
  const sentinel = 'sentinel-key-must-not-leak-6Zx9';
  try {
    const result = await runServerProcess([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shadertoy_library_status', arguments: {} } },
    ], { dataDir, apiKey: sentinel });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes(sentinel), false);
    assert.equal(result.stderr.includes(sentinel), false);
    const databaseBytes = await readFile(path.join(dataDir, 'library.sqlite3'));
    assert.equal(databaseBytes.includes(Buffer.from(sentinel, 'utf8')), false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('missing API key is a structured tool error, not an unstructured transport failure', async () => {
  const registry = createToolRegistry(makeRuntime());
  const server = new McpStdioServer({ registry, input: new PassThrough(), output: new PassThrough(), error: new PassThrough() });
  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 'refresh',
    method: 'tools/call',
    params: { name: 'refresh_shadertoy_project', arguments: { id: 'Xds3zN' } },
  });

  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.status, 'auth_required');
  assert.equal(response.result.structuredContent.error.code, 'auth_required');
});

test('refresh rejects an upstream id mismatch and reports the persisted license/attribution', async () => {
  const requestedId = 'A1B2C3';
  const mismatchRegistry = createToolRegistry({
    apiKey: 'configured',
    client: { getShader() { return { unexpected: true }; } },
    normalizeApiProject() { return { id: 'D4E5F6' }; },
    store: { upsertProject() { throw new Error('must not write mismatch'); } },
    analyzer: {},
  });
  const mismatch = await mismatchRegistry.call('refresh_shadertoy_project', { id: requestedId });
  assert.equal(mismatch.isError, true);
  assert.equal(mismatch.structuredContent.error.code, 'id_mismatch');

  let storedProject = null;
  const persistedLicense = { spdx: 'MIT', source: 'declared-license', commercial: 'allowed' };
  const successRegistry = createToolRegistry({
    apiKey: 'configured',
    client: { getShader(id) { return { id }; } },
    normalizeApiProject(payload) { return { id: payload.id, title: 'normalized title', license: 'upstream-stale' }; },
    store: {
      upsertProject(project) {
        storedProject = { ...project, author: 'persisted author', license: persistedLicense };
        return { id: project.id, created: true };
      },
      getProject() { return storedProject; },
    },
    analyzer: {},
  });
  const refreshed = await successRegistry.call('refresh_shadertoy_project', { id: requestedId });
  assert.equal(refreshed.isError, undefined);
  assert.equal(refreshed.structuredContent.project.title, 'normalized title');
  assert.deepEqual(refreshed.structuredContent.attribution.license, persistedLicense);
  assert.equal(refreshed.structuredContent.attribution.author, 'persisted author');
});

test('project reads omit full source by default and expose only a requested bounded source window', async () => {
  const registry = createToolRegistry(makeRuntime());
  const defaultResult = await registry.call('get_shadertoy_project', { id: 'Xds3zN' });
  assert.equal(JSON.stringify(defaultResult.structuredContent).includes('mainImage'), false);
  assert.deepEqual(defaultResult.structuredContent.attribution, {
    author: 'Example author',
    source_url: 'https://www.shadertoy.com/view/Xds3zN',
    license: 'CC BY-NC-SA 3.0',
    api_attribution: 'Shadertoy API',
  });

  const sourceResult = await registry.call('get_shadertoy_project', {
    id: 'Xds3zN',
    include_source: true,
    pass_index: 0,
    source_offset: 0,
    max_chars: 16,
  });
  assert.equal(sourceResult.structuredContent.source.text.length, 16);
  assert.equal(sourceResult.structuredContent.source.pass_index, 0);
  await assert.rejects(
    registry.call('get_shadertoy_project', { id: 'Xds3zN', include_source: true }),
    /requires pass_index/i,
  );
});

test('analysis output is bounded and does not echo submitted raw source', async () => {
  const registry = createToolRegistry(makeRuntime());
  const source = 'x'.repeat(2 * 1024 * 1024);
  const result = await registry.call('analyze_shadertoy_source', { source });
  const encoded = JSON.stringify(result.structuredContent);
  assert.equal(encoded.includes(source), false);
  assert.ok(encoded.length <= 70 * 1024);
});

test('analysis accepts a 2 MiB source through multibyte and escaped JSON framing', async () => {
  const registry = createToolRegistry(makeRuntime({
    analyzer: {
      analyzeShadertoySource(_source, { target }) {
        return { status: 'analyzed', target, findings: [], cost: { level: 'low', score: 1 } };
      },
    },
  }));
  const escapedAtLimit = '\\'.repeat(2 * 1024 * 1024);
  const multibyteAtLimit = 'é'.repeat(1024 * 1024);
  const messages = await runLines([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'analyze_shadertoy_source', arguments: { source: escapedAtLimit } },
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'analyze_shadertoy_source', arguments: { source: multibyteAtLimit } },
    },
  ], registry);
  assert.equal(messages[0].result.structuredContent.status, 'ok');
  assert.equal(messages[1].result.structuredContent.status, 'ok');
});

test('oversized analysis reports retain a stable structured report instead of a JSON-prefix summary', async () => {
  const registry = createToolRegistry(makeRuntime({
    analyzer: {
      analyzeShadertoySource() {
        return {
          status: 'analyzed',
          source: 'must-not-be-returned',
          cost: { level: 'high', score: 16, rationale: { details: 'x'.repeat(50_000) } },
          findings: Array.from({ length: 300 }, (_, index) => ({
            severity: 'warning',
            category: 'compatibility',
            code: `finding_${index}`,
            line: index + 1,
            message: 'x'.repeat(4_096),
          })),
          passes: Array.from({ length: 30 }, () => ({
            status: 'analyzed',
            findings: Array.from({ length: 30 }, () => ({ message: 'x'.repeat(4_096) })),
          })),
        };
      },
    },
  }));
  const result = await registry.call('analyze_shadertoy_source', { source: 'void main() {}' });
  const report = result.structuredContent.analysis;
  assert.equal(result.isError, undefined);
  assert.equal(report.status, 'analyzed');
  assert.equal(report.cost.level, 'high');
  assert.ok(Array.isArray(report.findings));
  assert.equal(report.truncated, true);
  assert.equal(Object.prototype.hasOwnProperty.call(report, 'summary'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 128 * 1024);
});

test('bounded sync cancellation propagates AbortSignal and has no late store mutation after return', async () => {
  let observedSignal = null;
  let mutations = 0;
  let completePostAbortCheck;
  const postAbortCheck = new Promise((resolve) => { completePostAbortCheck = resolve; });
  const registry = createToolRegistry({
    apiKey: 'configured-but-not-emitted',
    client: {},
    store: {},
    syncStepTimeoutMs: 10,
    async syncStep(_store, _client, { signal }) {
      observedSignal = signal;
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve({ status: 'cancelled', resumable: true });
          setImmediate(() => {
            if (!signal.aborted) {
              mutations += 1;
            }
            completePostAbortCheck();
          });
        }, { once: true });
      });
    },
    analyzer: {},
  });
  const result = await registry.call('sync_shadertoy_catalog_step', { limit: 1 });
  await postAbortCheck;
  assert.equal(observedSignal.aborted, true);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, 'cancelled');
  assert.equal(mutations, 0);
});

test('candidate ranking is deterministic from stored analysis and intersects query with ids', async () => {
  const lowCost = {
    id: 'A1B2C3',
    title: 'Local low-cost candidate',
    author: 'author-a',
    passes: [{ name: 'Image' }],
    analysis: {
      costLevel: 'low',
      cost: { score: 2 },
      feedback: false,
      findings: [],
    },
  };
  const higherCost = {
    id: 'D4E5F6',
    title: 'Local feedback candidate',
    author: 'author-b',
    passes: [{ name: 'Image' }],
    analysis: {
      costLevel: 'high',
      cost: { score: 16 },
      feedback: true,
      findings: [{ severity: 'warning' }],
    },
  };
  const projects = new Map([[lowCost.id, lowCost], [higherCost.id, higherCost]]);
  const registry = createToolRegistry({
    store: {
      search() {
        throw new Error('Explicit ids must be filtered locally rather than through a top-N FTS search.');
      },
      getProject(id) {
        return projects.get(id) || null;
      },
    },
    analyzer: {},
  });
  const result = await registry.call('rank_netease_candidates', {
    query: 'local',
    ids: ['A1B2C3'],
    limit: 25,
    target: 'gles100',
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.candidates.length, 1);
  assert.equal(result.structuredContent.candidates[0].id, 'A1B2C3');
  assert.equal(result.structuredContent.candidates[0].score, 100);
  assert.equal(result.structuredContent.candidates[0].cost.level, 'low');
  assert.equal(result.structuredContent.candidates[0].target.baseline, 'gles100');
  assert.equal(result.structuredContent.candidates[0].target.compile_validation, 'not_run');
  assert.equal(result.structuredContent.heuristic, true);
  assert.equal(JSON.stringify(result.structuredContent).includes('mainImage'), false);
});

test('candidate ranking handles no stored analysis and no local matches', async () => {
  const registry = createToolRegistry(makeRuntime({ analyzer: {} }));
  const noAnalysis = await registry.call('rank_netease_candidates', { ids: ['Xds3zN'] });
  assert.equal(noAnalysis.structuredContent.candidates[0].cost.level, 'unknown');
  assert.match(noAnalysis.structuredContent.candidates[0].reasons[0], /No stored analysis/i);

  const noMatch = await registry.call('rank_netease_candidates', { query: 'not-present' });
  assert.deepEqual(noMatch.structuredContent.candidates, []);
});

test('rank target constraints affect scores and unknown or zero-pass records do not outrank feasible stored analysis', async () => {
  const feasibleMedium = {
    id: 'A1B2C3',
    title: 'feasible medium',
    passes: [{ name: 'Image' }],
    analysis: { costLevel: 'medium', cost: { score: 8 }, findings: [] },
  };
  const targetConstrained = {
    id: 'D4E5F6',
    title: 'target constrained',
    passes: [{ name: 'Image' }],
    analysis: {
      costLevel: 'medium',
      cost: { score: 8 },
      findings: [],
      derivatives: [1],
      dynamicIndexing: [1],
      textureCalls: [{ name: 'texelFetch' }],
      version: { number: 300 },
    },
  };
  const noAnalysisNoPass = { id: 'G7H8J9', title: 'no analysis or passes' };
  const projects = new Map([
    [feasibleMedium.id, feasibleMedium],
    [targetConstrained.id, targetConstrained],
    [noAnalysisNoPass.id, noAnalysisNoPass],
  ]);
  const registry = createToolRegistry({
    store: {
      getProject(id) { return projects.get(id) || null; },
      search() { return []; },
    },
    analyzer: {},
  });
  const unconstrained = await registry.call('rank_netease_candidates', {
    ids: [targetConstrained.id], target: 'unknown',
  });
  const gles100 = await registry.call('rank_netease_candidates', {
    ids: [targetConstrained.id], target: 'gles100',
  });
  assert.ok(gles100.structuredContent.candidates[0].score < unconstrained.structuredContent.candidates[0].score);
  assert.deepEqual(gles100.structuredContent.candidates[0].target.constraints, [
    'derivatives', 'dynamic_array_indexing', 'advanced_texture_sampling', 'glsl_300_or_newer',
  ]);

  const mixed = await registry.call('rank_netease_candidates', {
    ids: [noAnalysisNoPass.id, feasibleMedium.id],
  });
  assert.equal(mixed.structuredContent.candidates[0].id, feasibleMedium.id);
  assert.equal(mixed.structuredContent.candidates[1].id, noAnalysisNoPass.id);
});

test('candidate ranking validates bounded limits and required local selectors', async () => {
  const registry = createToolRegistry(makeRuntime({ analyzer: {} }));
  await assert.rejects(registry.call('rank_netease_candidates', { limit: 25 }), /either query or ids/i);
  await assert.rejects(registry.call('rank_netease_candidates', { ids: ['Xds3zN'], limit: 26 }), /between 1 and 25/i);
  await assert.rejects(registry.call('rank_netease_candidates', { ids: ['Xds3zN'], target: 'invalid' }), /must be one of/i);
  await assert.rejects(
    registry.call('rank_netease_candidates', { ids: Array.from({ length: 26 }, () => 'Xds3zN') }),
    /between 1 and 25/i,
  );
});

test('CLI full sync counts the catalog and project fetches against its logical operation budget', async () => {
  const catalogOptions = [];
  const stepLimits = [];
  const result = await runCli(['sync', '--full', '--limit', '2'], {
    closeRuntime: false,
    runtimeFactory: async () => ({
      apiKey: 'configured',
      client: {},
      store: {},
      analyzer: {},
      async syncCatalog(_store, _client, options) {
        catalogOptions.push(options);
        return { status: 'success', stats: { listed: 4 } };
      },
      async syncStep(_store, _client, { limit }) {
        stepLimits.push(limit);
        return stepLimits.length === 1
          ? { status: 'partial', resumable: true, stats: { processed: limit, invalidIds: 0 } }
          : { status: 'success', resumable: false, stats: { processed: limit, invalidIds: 0 } };
      },
    }),
  });

  assert.equal(catalogOptions.length, 1);
  assert.deepEqual(stepLimits, [2, 2]);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.progress, {
    catalog: { status: 'success', stats: { listed: 4 } },
    steps: 2,
    totals: { processed: 4, invalidIds: 0 },
    budget: 100,
    consumed: 5,
    remaining: 95,
    resumable: false,
  });
});

test('CLI full sync does not start a fetch batch after a one-operation catalog budget is consumed', async () => {
  let catalogCalls = 0;
  const result = await runCli(['sync', '--full', '--max-operations', '1'], {
    closeRuntime: false,
    runtimeFactory: async () => ({
      apiKey: 'configured',
      client: {},
      store: {},
      analyzer: {},
      async syncCatalog() {
        catalogCalls += 1;
        return { status: 'success', stats: { listed: 10 } };
      },
    }),
  });

  assert.equal(catalogCalls, 1);
  assert.equal(result.status, 'partial');
  assert.equal(result.error.code, 'operation_budget_exhausted');
  assert.equal(result.progress.budget, 1);
  assert.equal(result.progress.consumed, 1);
  assert.equal(result.progress.remaining, 0);
  assert.equal(result.progress.resumable, true);
});

test('CLI full sync resume spends its budget only on pending project fetches', async () => {
  const stepLimits = [];
  const result = await runCli(['sync', '--full', '--resume', '--limit', '2', '--max-operations', '3'], {
    closeRuntime: false,
    runtimeFactory: async () => ({
      apiKey: 'configured',
      client: {},
      store: {},
      analyzer: {},
      async syncCatalog() {
        throw new Error('resume must not list the catalog');
      },
      async syncStep(_store, _client, { limit }) {
        stepLimits.push(limit);
        return stepLimits.length === 1
          ? { status: 'partial', resumable: true, stats: { processed: limit, invalidIds: 0 } }
          : { status: 'success', resumable: false, stats: { processed: limit, invalidIds: 0 } };
      },
    }),
  });

  assert.deepEqual(stepLimits, [2, 1]);
  assert.equal(result.status, 'success');
  assert.equal(result.progress.catalog, null);
  assert.equal(result.progress.budget, 3);
  assert.equal(result.progress.consumed, 3);
  assert.equal(result.progress.remaining, 0);
  assert.equal(result.progress.resumable, false);
});

test('CLI full sync stops before starting another fetch batch after its budget is exhausted', async () => {
  const stepLimits = [];
  const result = await runCli(['sync', '--full', '--limit', '3', '--max-operations', '5'], {
    closeRuntime: false,
    runtimeFactory: async () => ({
      apiKey: 'configured',
      client: {},
      store: {},
      analyzer: {},
      async syncCatalog() {
        return { status: 'success', stats: { listed: 10 } };
      },
      async syncStep(_store, _client, { limit }) {
        stepLimits.push(limit);
        return { status: 'partial', resumable: true, stats: { processed: limit, invalidIds: 0 } };
      },
    }),
  });

  assert.deepEqual(stepLimits, [3, 1]);
  assert.equal(result.status, 'partial');
  assert.equal(result.isError, true);
  assert.equal(result.error.code, 'operation_budget_exhausted');
  assert.equal(result.progress.budget, 5);
  assert.equal(result.progress.consumed, 5);
  assert.equal(result.progress.remaining, 0);
  assert.equal(result.progress.resumable, true);
});

test('CLI full sync strictly validates its total logical operation budget', async () => {
  const options = {
    closeRuntime: false,
    runtimeFactory: async () => ({ apiKey: 'configured', client: {}, store: {}, analyzer: {} }),
  };
  for (const value of ['0', '1501', '9007199254740992']) {
    await assert.rejects(
      runCli(['sync', '--full', '--max-operations', value], options),
      /--max-operations must be an integer between 1 and 1500/i,
    );
  }
  await assert.rejects(
    runCli(['sync', '--full', '--max-operations', 'not-a-number'], options),
    /--max-operations must be an integer/i,
  );
  await assert.rejects(
    runCli(['sync', '--max-operations', '10'], options),
    /--max-operations requires --full/i,
  );
  await assert.rejects(
    runCli(['sync', '--full', '--max-operations', '0'], {
      closeRuntime: false,
      runtimeFactory: async () => ({ apiKey: '', client: null, store: {}, analyzer: {} }),
    }),
    /--max-operations must be an integer between 1 and 1500/i,
  );
});

test('CLI full sync without an API key retains the structured auth-required response', async () => {
  const result = await runCli(['sync', '--full'], {
    closeRuntime: false,
    runtimeFactory: async () => ({ apiKey: '', client: null, store: {}, analyzer: {} }),
  });

  assert.deepEqual(result, {
    status: 'auth_required',
    command: 'sync',
    isError: true,
    error: {
      code: 'auth_required',
      message: 'Set SHADERTOY_API_KEY in the CLI environment before full synchronization.',
    },
  });
});

test('CLI import-json accepts an official single-shader response object', async () => {
  const inserted = [];
  const fixturePath = fileURLToPath(new URL('./fixtures/synthetic-shader.json', import.meta.url));
  const result = await runCli(['import-json', fixturePath], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    closeRuntime: false,
    runtimeFactory: async () => ({
      store: {
        upsertProject(project) {
          inserted.push(project);
        },
      },
      normalizeApiProject(payload) {
        return { id: payload.Shader.info.id, title: payload.Shader.info.name };
      },
    }),
  });

  assert.deepEqual(result, { status: 'ok', command: 'import-json', imported: 1, skipped: 0 });
  assert.deepEqual(inserted, [{ id: 'AbC123', title: 'Synthetic Hex Pulse' }]);
});

test('CLI import-json rejects UNC and Windows device namespaces before filesystem access', async () => {
  const runtimeFactory = async () => ({ store: {} });
  for (const unsafePath of [
    '\\\\server\\share\\catalog.json',
    '\\\\?\\C:\\catalog.json',
    '\\\\.\\pipe\\catalog.json',
    '\\??\\C:\\catalog.json',
    '//server/share/catalog.json',
  ]) {
    await assert.rejects(
      runCli(['import-json', unsafePath], { runtimeFactory }),
      /explicit local filesystem path/i,
    );
  }
});
