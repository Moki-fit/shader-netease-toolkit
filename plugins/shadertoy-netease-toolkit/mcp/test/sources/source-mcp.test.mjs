import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { MCP_PROTOCOL_VERSION } from '../../src/mcp-server.mjs';
import { analyzeSource as analyzeGlslSource } from '../../src/analyzer.mjs';
import { SOURCE_SERVER_INFO, SourceMcpStdioServer } from '../../src/sources/source-mcp-server.mjs';
import { createSourceRegistry } from '../../src/sources/source-registry.mjs';
import { defaultSourceDataDirectory, defaultSourceDatabasePath } from '../../src/sources/source-runtime.mjs';
import {
  SOURCE_TOOL_DEFINITIONS,
  createSourceToolRegistry,
} from '../../src/sources/source-tools.mjs';

const CONTENT_SENTINEL = 'private cached source must not be returned by default';

test('source runtime gives SHADER_SOURCE_DATA_DIR priority while retaining the legacy data-directory fallback', () => {
  const explicit = defaultSourceDataDirectory({
    SHADER_SOURCE_DATA_DIR: 'D:\\cache\\sources',
    SHADERTOY_DATA_DIR: 'D:\\cache\\legacy',
  });
  const fallback = defaultSourceDataDirectory({ SHADERTOY_DATA_DIR: 'D:\\cache\\legacy' });
  assert.equal(explicit, 'D:\\cache\\sources');
  assert.equal(fallback, 'D:\\cache\\legacy');
  assert.equal(defaultSourceDatabasePath({}, explicit), path.join(explicit, 'resources-v2.sqlite3'));
});

function makeRuntime(overrides = {}) {
  const record = {
    ref: { provider: 'isf', id: 'main.fs' },
    kind: 'shader',
    title: 'Test ISF effect',
    author: 'Example author',
    description: 'A local test resource.',
    tags: ['test', 'isf'],
    language: 'glsl',
    canonicalUrl: 'https://raw.githubusercontent.com/Vidvox/ISF-Files/main/ISF/Test/main.fs',
    rights: {
      spdx: 'MIT',
      reviewRequired: false,
      evidence: [{
        kind: 'repository-license',
        text: 'MIT License; retain the upstream copyright and license notice.',
      }],
    },
    provenance: { acquisition: 'fixture' },
    authorization: { basis: 'repository-license' },
    contentPolicy: { mode: 'full_source' },
    metadata: {
      sourceType: 'fixture',
      inlineSource: CONTENT_SENTINEL,
      passes: [{
        TARGET: 'history',
        PERSISTENT: true,
        FLOAT: true,
        WIDTH: 512,
        HEIGHT: 512,
        source: CONTENT_SENTINEL,
        code: CONTENT_SENTINEL,
      }],
    },
    blobs: [{ role: 'fragment', mimeType: 'text/plain', body: CONTENT_SENTINEL }],
    bodyBytes: Buffer.byteLength(CONTENT_SENTINEL, 'utf8'),
    blobCount: 1,
  };
  const providers = [
    { id: 'shadertoy', displayName: 'Shadertoy', kind: 'shader', capabilities: [], licensePolicy: {}, networkPolicy: {}, notes: [] },
    { id: 'isf', displayName: 'ISF', kind: 'shader', capabilities: ['resolve-url', 'sync'], licensePolicy: {}, networkPolicy: {}, notes: [] },
    { id: 'twigl', displayName: 'twigl', kind: 'shader', capabilities: [], licensePolicy: {}, networkPolicy: {}, notes: [] },
    { id: 'book-of-shaders', displayName: 'The Book of Shaders', kind: 'knowledge', capabilities: [], licensePolicy: {}, networkPolicy: {}, notes: [] },
    { id: 'shaderfrog', displayName: 'ShaderFrog', kind: 'shader', capabilities: [], licensePolicy: {}, networkPolicy: {}, notes: [] },
    { id: 'godot-shaders', displayName: 'Godot Shaders', kind: 'shader', capabilities: [], licensePolicy: {}, networkPolicy: {}, notes: [] },
    { id: 'webgl-fundamentals', displayName: 'WebGL Fundamentals', kind: 'knowledge', capabilities: [], licensePolicy: {}, networkPolicy: {}, notes: [] },
  ];
  const registry = {
    list() { return providers; },
    resolveUrl(url) {
      if (url !== 'https://example.invalid/isf') {
        return null;
      }
      return {
        ref: { provider: 'isf', id: 'main.fs' },
        kind: 'shader',
        canonicalUrl: record.canonicalUrl,
        accessMode: 'fixture-only',
        licensePolicy: { spdx: 'MIT' },
        metadata: { inlineSource: CONTENT_SENTINEL, sourceType: 'fixture' },
      };
    },
  };
  return {
    registry,
    store: {
      status() {
        return {
          schemaVersion: 1,
          path: 'must-not-appear.sqlite3',
          counts: { resources: 1, shaders: 1, knowledge: 0, blobs: 1 },
        };
      },
      search() {
        const { blobs, ...summary } = record;
        return [summary];
      },
      getResource(ref) {
        return ref.provider === record.ref.provider && ref.id === record.ref.id ? record : null;
      },
    },
    service: {
      resolveLink(url) { return registry.resolveUrl(url); },
      importLink({ url, authorizationBasis }) {
        const resolved = registry.resolveUrl(url);
        return resolved
          ? {
            status: 'ok',
            provider: 'isf',
            operation: 'import',
            ref: resolved.ref,
            resolved,
            resource: { ...record, authorization: { basis: authorizationBasis } },
          }
          : { status: 'error', error: { code: 'unsupported_url', provider: 'isf', operation: 'import' } };
      },
      syncStep({ provider, limit, signal }) {
        return { status: 'ok', provider, operation: 'sync', limit, signalObserved: Boolean(signal) };
      },
    },
    analyzer: {
      analyzeSource(source, { target }) {
        return {
          status: 'analyzed',
          target,
          source,
          findings: [],
          cost: { level: 'low', score: 1 },
        };
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
  output.on('data', (chunk) => { stdout += chunk; });
  const server = new SourceMcpStdioServer({ input, output, error, registry });
  const finished = server.start();
  input.end(lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
  await finished;
  return { stdout, messages: stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
}

async function runSourceServerProcess(lines, options = {}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'shader-source-registry-mcp-'));
  const dataDir = options.dataDir || path.join(temporaryRoot, 'data');
  const serverPath = fileURLToPath(new URL('../../src/sources/source-mcp-server.mjs', import.meta.url));
  try {
    const child = spawn(process.execPath, [serverPath], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, ...(options.environment || {}), SHADERTOY_DATA_DIR: dataDir },
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

test('source MCP advertises exactly the seven isolated source tools and accepts an MCP handshake', async () => {
  const registry = createSourceToolRegistry(makeRuntime());
  const { stdout, messages } = await runLines([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'shader_source_registry_status', arguments: {} } },
  ], registry);

  assert.equal(messages.length, 3);
  assert.equal(messages[0].result.serverInfo.name, SOURCE_SERVER_INFO.name);
  assert.equal(messages[0].result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.deepEqual(messages[1].result.tools.map((tool) => tool.name), SOURCE_TOOL_DEFINITIONS.map((tool) => tool.name));
  assert.equal(messages[2].result.structuredContent.status, 'ok');
  assert.equal(messages[2].result.structuredContent.cache_counts.resources, 1);
  assert.equal(messages[2].result.structuredContent.cache_counts.blobs, 1);
  assert.equal(messages[2].result.structuredContent.cache.path, undefined);
  assert.equal(stdout.split('\n').filter(Boolean).every((line) => {
    try { JSON.parse(line); return true; } catch { return false; }
  }), true);
});

test('source MCP routes strict parameter failures to JSON-RPC invalid params and rejects unknown tools', async () => {
  const registry = createSourceToolRegistry(makeRuntime());
  const { messages } = await runLines([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sync_shader_source_step', arguments: { provider: 'isf', limit: 11 } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_shader_source_record', arguments: { provider: 'isf', id: 'main.fs', include_content: true } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_shader_sources', arguments: { query: 'test', unexpected: true } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'missing_source_tool', arguments: {} } },
  ], registry);

  for (const message of messages) {
    assert.equal(message.error.code, -32602);
  }
  assert.match(messages[0].error.message, /between 1 and 10/i);
  assert.match(messages[1].error.message, /requires blob_index/i);
  assert.deepEqual(messages[2].error.data, { properties: ['unexpected'] });
  assert.equal(messages[3].error.data.name, 'missing_source_tool');
});

test('source records and URL resolution omit content by default but expose one explicit bounded window', async () => {
  const registry = createSourceToolRegistry(makeRuntime());
  const defaultRecord = await registry.call('get_shader_source_record', { provider: 'isf', id: 'main.fs' });
  const resolved = await registry.call('resolve_shader_source_url', { url: 'https://example.invalid/isf' });
  const search = await registry.call('search_shader_sources', { query: 'test' });
  const imported = await registry.call('import_shader_link', {
    url: 'https://example.invalid/isf',
    authorization_basis: 'repository-license',
  });

  for (const result of [defaultRecord, resolved, search, imported]) {
    assert.equal(JSON.stringify(result.structuredContent).includes(CONTENT_SENTINEL), false);
  }
  assert.equal(defaultRecord.structuredContent.content_included, false);
  assert.equal(search.structuredContent.content_included, false);
  assert.equal(imported.structuredContent.content_included, false);
  assert.equal(search.structuredContent.results[0].blob_count, 1);
  assert.equal(search.structuredContent.results[0].content_available, true);
  assert.deepEqual(defaultRecord.structuredContent.record.metadata.passes, [{
    TARGET: 'history',
    PERSISTENT: true,
    FLOAT: true,
    WIDTH: 512,
    HEIGHT: 512,
  }]);
  assert.equal(Object.hasOwn(defaultRecord.structuredContent.record.metadata.passes[0], 'source'), false);
  assert.equal(Object.hasOwn(defaultRecord.structuredContent.record.metadata.passes[0], 'code'), false);
  assert.equal(
    defaultRecord.structuredContent.record.rights.evidence[0].text,
    'MIT License; retain the upstream copyright and license notice.',
  );

  const window = await registry.call('get_shader_source_record', {
    provider: 'isf',
    id: 'main.fs',
    include_content: true,
    blob_index: 0,
    content_offset: 0,
    max_chars: 7,
  });
  assert.equal(window.structuredContent.content.text, CONTENT_SENTINEL.slice(0, 7));
  assert.equal(window.structuredContent.content.total_chars, CONTENT_SENTINEL.length);
  assert.equal(window.structuredContent.content.truncated, true);
});

test('import uses the nested resource from a provider-service operation envelope', async () => {
  const registry = createSourceToolRegistry(makeRuntime());
  const imported = await registry.call('import_shader_link', {
    url: 'https://example.invalid/isf',
    authorization_basis: 'repository-license',
  });
  const resource = imported.structuredContent.resource;
  assert.equal(imported.isError, undefined);
  assert.equal(resource.kind, 'shader');
  assert.equal(resource.title, 'Test ISF effect');
  assert.equal(resource.author, 'Example author');
  assert.equal(resource.blob_count, 1);
  assert.equal(resource.content_available, true);
  assert.equal(JSON.stringify(resource).includes(CONTENT_SENTINEL), false);
});

test('an inline twigl source URL is recognized without leaking its query-carried source text', async () => {
  const source = 'void main(){/* twigl-private */}';
  const sourceUrl = `https://twigl.app/?mode=1&source=${encodeURIComponent(source)}`;
  const actualRegistry = createSourceRegistry();
  const registry = createSourceToolRegistry(makeRuntime({
    registry: actualRegistry,
    service: {
      resolveLink(url) { return actualRegistry.resolveUrl(url); },
      importLink() { throw new Error('not used'); },
      syncStep() { throw new Error('not used'); },
    },
  }));
  const result = await registry.call('resolve_shader_source_url', { url: sourceUrl });
  const encoded = JSON.stringify(result.structuredContent);
  assert.equal(result.isError, undefined);
  assert.equal(encoded.includes(source), false);
  assert.equal(encoded.includes('twigl-private'), false);
  assert.match(result.structuredContent.source.canonicalUrl, /source=.*redacted/i);
});

test('source analysis does not echo submitted source and explicitly disclaims compilation and NetEase validation', async () => {
  const registry = createSourceToolRegistry(makeRuntime());
  const source = `${CONTENT_SENTINEL}\nshader_type canvas_item;\nvoid fragment() {}`;
  const result = await registry.call('analyze_shader_source', {
    provider: 'godot-shaders',
    source,
    target: 'gles300',
  });
  const encoded = JSON.stringify(result.structuredContent);
  assert.equal(result.isError, undefined);
  assert.equal(encoded.includes(CONTENT_SENTINEL), false);
  assert.equal(result.structuredContent.analysis.compiled, false);
  assert.equal(result.structuredContent.analysis.validation.mcdk_validation, 'not_run');
  assert.match(result.structuredContent.disclaimer, /did not compile/i);
  assert.match(result.structuredContent.disclaimer, /NetEase/i);
  assert.ok(result.structuredContent.analysis.findings.some((finding) => finding.code === 'godot_host_contract'));
});

test('source analysis preserves a GLSL version profile while removing location-like fields', async () => {
  const registry = createSourceToolRegistry(makeRuntime({
    analyzer: { analyzeSource: analyzeGlslSource },
  }));
  const result = await registry.call('analyze_shader_source', {
    provider: 'isf',
    source: '#version 300 es\nuniform sampler2D iChannel0;\nvoid main() { vec4 color = texture(iChannel0, vec2(0.0)); }',
    target: 'gles300',
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.analysis.version.number, 300);
  assert.equal(result.structuredContent.analysis.version.profile, 'es');
  const findingCodes = result.structuredContent.analysis.findings.map((finding) => finding.code);
  assert.ok(findingCodes.includes('texture_sampling'));
  assert.ok(findingCodes.includes('ichannel_reference'));
});

test('source sync is constrained to ten entries and passes a cancellation-aware signal to the provider service', async () => {
  const registry = createSourceToolRegistry(makeRuntime());
  const result = await registry.call('sync_shader_source_step', { provider: 'isf', limit: 10 });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.limit, 10);
  assert.equal(result.structuredContent.sync.signalObserved, true);
  await assert.rejects(
    registry.call('sync_shader_source_step', { provider: 'isf', limit: 11 }),
    /between 1 and 10/i,
  );
});

test('real source MCP child emits only JSON-RPC on stdout and creates the isolated V2 database', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'shader-source-registry-real-'));
  const dataDir = path.join(temporaryRoot, 'nested', 'data');
  try {
    const result = await runSourceServerProcess([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'shader_source_registry_status', arguments: {} } },
    ], { dataDir, cleanup: false });
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const messages = lines.map((line) => JSON.parse(line));
    assert.equal(result.exitCode, 0);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].result.serverInfo.name, SOURCE_SERVER_INFO.name);
    assert.equal(messages[1].result.tools.length, 7);
    assert.equal(messages[2].result.structuredContent.status, 'ok');
    assert.equal((await stat(path.join(dataDir, 'resources-v2.sqlite3'))).isFile(), true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('a configured optional GitHub token is not emitted or persisted by offline source-registry status', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'shader-source-registry-token-'));
  const dataDir = path.join(temporaryRoot, 'data');
  const token = 'token-must-not-appear-in-source-registry-output';
  try {
    const result = await runSourceServerProcess([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shader_source_registry_status', arguments: {} } },
    ], {
      dataDir,
      cleanup: false,
      environment: { GITHUB_TOKEN: token },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes(token), false);
    assert.equal(result.stderr.includes(token), false);
    const bytes = await readFile(path.join(dataDir, 'resources-v2.sqlite3'));
    assert.equal(bytes.includes(Buffer.from(token, 'utf8')), false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
