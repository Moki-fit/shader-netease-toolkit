import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BoundedHttpError, createBoundedHttpClient } from '../../src/sources/bounded-http.mjs';
import { normalizeIsfResource } from '../../src/sources/normalizers.mjs';
import { createProviderService } from '../../src/sources/provider-service.mjs';
import { createSourceRegistry } from '../../src/sources/source-registry.mjs';
import { ProviderSyncLeaseError, SourceStore } from '../../src/sources/source-store.mjs';
import {
  githubFilePayload,
  ISF_COMMIT,
  ISF_FRAGMENT,
  ISF_SECOND_FRAGMENT,
  ISF_VERTEX,
  jsonResponse,
  MemorySourceStore,
  textResponse,
  WEBGL_CHINESE,
  WEBGL_COMMIT,
  WEBGL_ENGLISH,
  WEBGL_OTHER,
  WEBGL_TRAILING,
} from '../../fixtures/provider-service-fixtures.mjs';

function serviceWith(fetch, store = new MemorySourceStore()) {
  // The production SourceStore is tested separately for SQLite CAS and
  // transactions. This lightweight double models its visible lease contract.
  if (typeof store.claimProviderSyncRun !== 'function') {
    const runs = new Map();
    let sequence = 0;
    const own = (provider, runToken, revision = null) => {
      const run = runs.get(provider);
      if (!run || run.token !== runToken || (revision !== null && run.revision !== null && run.revision !== revision)) {
        throw new ProviderSyncLeaseError();
      }
      if (revision !== null && run.revision === null) run.revision = revision;
    };
    store.claimProviderSyncRun = (provider) => {
      if (runs.has(provider)) return { acquired: false };
      sequence += 1;
      const runToken = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
      runs.set(provider, { token: runToken, revision: null });
      return { acquired: true, runToken };
    };
    store.releaseProviderSyncRun = (provider, runToken) => {
      const run = runs.get(provider);
      if (!run || run.token !== runToken) return false;
      runs.delete(provider);
      return true;
    };
    store.heartbeatProviderSyncRun = (provider, runToken) => {
      own(provider, runToken);
      return true;
    };
    store.upsertResourceForProviderSync = (provider, runToken, revision, record) => {
      own(provider, runToken, revision);
      return store.upsertResource(record);
    };
    store.setSyncStateForProviderSync = (provider, runToken, state) => {
      own(provider, runToken, state.revision);
      return store.setSyncState(provider, state);
    };
    store.completeProviderSync = (provider, runToken, state, eligibleResourceIds) => {
      own(provider, runToken, state.revision);
      if (state.status !== 'complete') {
        throw new TypeError('Provider reconciliation requires a complete sync state.');
      }
      const eligible = new Set(eligibleResourceIds);
      let removedResources = 0;
      for (const [key, record] of store.resources) {
        if (record.ref.provider === provider && !eligible.has(record.ref.id)) {
          store.resources.delete(key);
          removedResources += 1;
        }
      }
      const completed = store.setSyncState(provider, state);
      runs.delete(provider);
      return { ...completed, removedResources };
    };
  }
  return {
    store,
    service: createProviderService({
      registry: createSourceRegistry(),
      store,
      fetch,
      environment: { GITHUB_TOKEN: 'test-token-must-not-escape' },
      now: () => 0,
    }),
  };
}

function routeFetch(routes, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const route = routes.get(url);
    if (!route) {
      throw new Error(`unexpected URL ${url}`);
    }
    const response = typeof route === 'function' ? route(url, init) : route;
    return response instanceof Response ? response.clone() : response;
  };
}

async function withSharedDatabase(work) {
  const directory = mkdtempSync(join(tmpdir(), 'shadertoy-netease-provider-service-'));
  try {
    return await work(join(directory, 'resources.sqlite3'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function makeIsfRecord(path, revision = ISF_COMMIT) {
  return normalizeIsfResource({
    ref: { provider: 'isf', id: path },
    canonicalUrl: `https://github.com/Vidvox/ISF-Files/blob/${revision}/${path}`,
    path,
    fragmentSource: ISF_SECOND_FRAGMENT,
    commit: revision,
    blobSha: 'a'.repeat(40),
    now: () => 0,
  });
}

test('bounded provider HTTP rejects arbitrary targets, manual redirects, oversized responses, and propagates cancellation', async () => {
  const calls = [];
  const client = createBoundedHttpClient({
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/redirect')) return new Response('', { status: 302, headers: { location: 'https://example.invalid/' } });
      if (url.endsWith('/large')) return new Response('', { status: 200, headers: { 'content-length': String(2 * 1024 * 1024 + 1) } });
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    client.get('https://untrusted.invalid/', { responseType: 'text', allow: () => false }),
    (error) => error instanceof BoundedHttpError && error.code === 'invalid_response',
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    client.get('https://fixed.invalid/redirect', { responseType: 'text', allow: () => true }),
    (error) => error instanceof BoundedHttpError && error.code === 'redirect_blocked',
  );
  assert.equal(calls.at(-1).init.redirect, 'manual');
  await assert.rejects(
    client.get('https://fixed.invalid/large', { responseType: 'text', allow: () => true }),
    (error) => error instanceof BoundedHttpError && error.code === 'response_too_large',
  );
  const controller = new AbortController();
  const request = client.get('https://fixed.invalid/stall', { responseType: 'text', allow: () => true, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(request, (error) => error instanceof BoundedHttpError && error.code === 'cancelled');
  assert.equal(calls.at(-1).init.signal.aborted, true);
});

test('retryable, timed-out, and cancelled sync failures are resumable without writes', async () => {
  const commitUrl = 'https://api.github.com/repos/Vidvox/ISF-Files/commits/master';

  const rateStore = new MemorySourceStore();
  const { service: rateService } = serviceWith(routeFetch(new Map([
    [commitUrl, jsonResponse({ message: 'slow down' }, 429)],
  ]), []), rateStore);
  const rateLimited = await rateService.syncStep({ provider: 'isf', limit: 1 });
  assert.equal(rateLimited.status, 'error');
  assert.equal(rateLimited.error.code, 'rate_limited');
  assert.equal(rateLimited.error.retryable, true);
  assert.equal(rateLimited.error.resumable, true);
  assert.equal(rateStore.resources.size, 0);
  assert.equal(rateStore.states.size, 0);

  const timeoutStore = new MemorySourceStore();
  const { service: timeoutService } = serviceWith(async () => {
    throw new BoundedHttpError('upstream_timeout');
  }, timeoutStore);
  const timedOut = await timeoutService.syncStep({ provider: 'isf', limit: 1 });
  assert.equal(timedOut.status, 'error');
  assert.equal(timedOut.error.code, 'upstream_timeout');
  assert.equal(timedOut.error.retryable, true);
  assert.equal(timedOut.error.resumable, true);
  assert.equal(timeoutStore.resources.size, 0);
  assert.equal(timeoutStore.states.size, 0);

  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const cancelledStore = new MemorySourceStore();
  const { service: cancelledService } = serviceWith((url, init) => new Promise((resolve, reject) => {
    void url;
    void resolve;
    markFetchStarted();
    init.signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
  }), cancelledStore);
  const controller = new AbortController();
  const cancellation = cancelledService.syncStep({ provider: 'isf', limit: 1, signal: controller.signal });
  await fetchStarted;
  controller.abort();
  const cancelled = await cancellation;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error.code, 'cancelled');
  assert.equal(cancelled.error.retryable, false);
  assert.equal(cancelled.error.resumable, true);
  assert.equal(cancelledStore.resources.size, 0);
  assert.equal(cancelledStore.states.size, 0);
});

test('claim, heartbeat, and sync-state read store faults are resumable before any upstream request', async () => {
  const claimStore = new MemorySourceStore();
  const claimCalls = [];
  const { service: claimService } = serviceWith(async (...args) => {
    claimCalls.push(args);
    throw new Error('claim failure must stop before fetch');
  }, claimStore);
  claimStore.claimProviderSyncRun = () => {
    throw new Error('forced claim store failure');
  };
  const claim = await claimService.syncStep({ provider: 'isf', limit: 1 });
  assert.equal(claim.status, 'error');
  assert.equal(claim.error.code, 'store_error');
  assert.equal(claim.error.resumable, true);
  assert.equal(claimCalls.length, 0);

  const heartbeatStore = new MemorySourceStore();
  const heartbeatCalls = [];
  const { service: heartbeatService } = serviceWith(async (...args) => {
    heartbeatCalls.push(args);
    throw new Error('heartbeat failure must stop before fetch');
  }, heartbeatStore);
  heartbeatStore.heartbeatProviderSyncRun = () => {
    throw new Error('forced heartbeat store failure');
  };
  const heartbeat = await heartbeatService.syncStep({ provider: 'isf', limit: 1 });
  assert.equal(heartbeat.status, 'error');
  assert.equal(heartbeat.error.code, 'store_error');
  assert.equal(heartbeat.error.resumable, true);
  assert.equal(heartbeatCalls.length, 0);

  const stateStore = new MemorySourceStore();
  const stateCalls = [];
  const { service: stateService } = serviceWith(async (...args) => {
    stateCalls.push(args);
    throw new Error('state read failure must stop before fetch');
  }, stateStore);
  stateStore.getSyncState = () => {
    throw new Error('forced sync-state read failure');
  };
  const state = await stateService.syncStep({ provider: 'isf', limit: 1 });
  assert.equal(state.status, 'error');
  assert.equal(state.error.code, 'store_error');
  assert.equal(state.error.resumable, true);
  assert.equal(stateCalls.length, 0);
});

test('twigl inline import decodes locally, blocks channel links, and gates source caching by authorization', async () => {
  const calls = [];
  const { service, store } = serviceWith(async (...args) => {
    calls.push(args);
    throw new Error('twigl inline links must not fetch');
  });
  const source = 'void main(){gl_FragColor=vec4(1.0);}';
  const inlineUrl = `https://twigl.app/?mode=0&source=${encodeURIComponent(source)}`;

  const metadataOnly = await service.importLink({ url: inlineUrl, authorizationBasis: 'reference-only' });
  assert.equal(metadataOnly.status, 'ok');
  assert.equal(metadataOnly.resource.blobs.length, 0);
  assert.equal(metadataOnly.resource.metadata.sourceCached, false);
  assert.equal(metadataOnly.resource.canonicalUrl, 'https://twigl.app/');
  assert.equal(JSON.stringify(metadataOnly.resource).includes(source), false, 'metadata-only storage must not retain inline source text');
  assert.equal(JSON.stringify(metadataOnly.resolved).includes(source), false, 'service result must not expose inline source text');
  assert.equal(calls.length, 0);

  const authorized = await service.importLink({ url: inlineUrl, authorizationBasis: 'user-owned' });
  assert.equal(authorized.status, 'ok');
  assert.equal(authorized.resource.blobs[0].body, source);
  assert.equal(authorized.resource.metadata.sourceCached, true);
  const { blobs: authorizedBlobs, ...authorizedWithoutBlobs } = authorized.resource;
  assert.equal(JSON.stringify(authorizedWithoutBlobs).includes(source), false, 'authorized source must exist only in its blob');
  assert.equal(JSON.stringify(authorized.resolved).includes(source), false, 'authorized result metadata must stay redacted');
  assert.equal(authorizedBlobs.length, 1);
  assert.equal(calls.length, 0);

  const blocked = await service.importLink({
    url: 'https://twigl.app?ol=true&ss=shareA&ch=do-not-follow',
    authorizationBasis: 'user-owned',
  });
  assert.equal(blocked.status, 'error');
  assert.equal(blocked.error.code, 'unsupported_url');
  assert.equal(calls.length, 0);
  assert.equal(store.resources.size, 1, 'same inline id upserts rather than duplicating');
});

test('twigl share snapshot performs exactly one fixed manual-redirect request and never leaks authorization', async () => {
  const calls = [];
  const snapshotUrl = 'https://twigl-f67a0.firebaseio.com/snapshot/shareA.json';
  const { service } = serviceWith(routeFetch(new Map([
    [snapshotUrl, (url, init) => {
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.Authorization, undefined);
      return jsonResponse({
        graphics: { source: 'void main(){gl_FragColor=vec4(0.0);}', mode: 8 },
        sound: { source: 'float mainSound(float t){return sin(t);}' },
      });
    }],
  ]), calls));

  const shareUrl = 'https://twigl.app?ol=true&ss=shareA';
  const referenceOnly = await service.importLink({
    url: shareUrl,
    authorizationBasis: 'reference-only',
  });
  assert.equal(referenceOnly.status, 'ok');
  assert.equal(referenceOnly.resource.contentPolicy, 'metadata_only');
  assert.equal(referenceOnly.resource.blobs.length, 0);
  assert.equal(referenceOnly.resource.provenance.snapshotFetchSkippedByAuthorization, true);
  assert.equal(calls.length, 0, 'reference-only must not retrieve a user share snapshot');

  const repositoryLicense = await service.importLink({
    url: shareUrl,
    authorizationBasis: 'repository-license',
  });
  assert.equal(repositoryLicense.status, 'ok');
  assert.equal(repositoryLicense.resource.blobs.length, 0);
  assert.equal(calls.length, 0, 'a repository license does not authorize a twigl user work');

  const result = await service.importLink({
    url: shareUrl,
    authorizationBasis: 'author-permission',
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.resource.blobs.length, 2);
  assert.equal(result.resource.blobs.find((blob) => blob.role === 'sound').body, 'float mainSound(float t){return sin(t);}');
  assert.equal(result.resource.metadata.mode, 8);
  assert.equal(result.resource.metadata.sound.requiresManualPorting, true);
  assert.equal(result.resource.provenance.experimentalSnapshotEndpoint, true);
  assert.equal(calls.length, 1);
});

test('ISF sync only reads the fixed standard library, persists cursor progress, and parses ISF metadata without assets', async () => {
  const calls = [];
  const commitUrl = 'https://api.github.com/repos/Vidvox/ISF-Files/commits/master';
  const treeUrl = `https://api.github.com/repos/Vidvox/ISF-Files/git/trees/${ISF_COMMIT}?recursive=1`;
  const fragmentUrl = `https://api.github.com/repos/Vidvox/ISF-Files/contents/ISF/Fixture.fs?ref=${ISF_COMMIT}`;
  const vertexUrl = `https://api.github.com/repos/Vidvox/ISF-Files/contents/ISF/Fixture.vs?ref=${ISF_COMMIT}`;
  const routes = new Map([
    [commitUrl, jsonResponse({ sha: ISF_COMMIT })],
    [treeUrl, jsonResponse({ truncated: false, tree: [
      { type: 'blob', path: 'ISF/Fixture.fs', sha: 'f'.repeat(40) },
      { type: 'blob', path: 'ISF/Fixture.vs', sha: 'a'.repeat(40) },
      { type: 'blob', path: 'ISF/Second.fs', sha: 'b'.repeat(40) },
      { type: 'blob', path: 'README.md', sha: 'c'.repeat(40) },
      { type: 'blob', path: 'Other/ignore.fs', sha: 'd'.repeat(40) },
    ] })],
    [fragmentUrl, jsonResponse(githubFilePayload(ISF_FRAGMENT))],
    [vertexUrl, jsonResponse(githubFilePayload(ISF_VERTEX))],
    [`https://api.github.com/repos/Vidvox/ISF-Files/contents/ISF/Second.fs?ref=${ISF_COMMIT}`, jsonResponse(githubFilePayload(ISF_SECOND_FRAGMENT))],
  ]);
  const { service, store } = serviceWith(routeFetch(routes, calls));

  const first = await service.syncStep({ provider: 'isf', limit: 1 });
  assert.equal(first.status, 'partial');
  assert.equal(first.processed, 1);
  assert.equal(first.total, 2);
  assert.equal(store.getSyncState('isf').cursor, '1');
  const record = store.getResource({ provider: 'isf', id: 'ISF/Fixture.fs' });
  assert.equal(record.rights.spdx, 'MIT');
  assert.equal(record.author, 'Fixture Author');
  assert.equal(record.metadata.passes[0].PERSISTENT, true);
  assert.equal(record.metadata.imported[0].path, 'images/sprite.png');
  assert.equal(record.metadata.importedAssetsDownloaded, false);
  assert.equal(record.blobs.length, 2);
  assert.deepEqual(record.authorization, { basis: 'repository-license', assertedBy: 'official-provider-policy' });
  assert.ok(calls.every(({ url }) => url.startsWith('https://api.github.com/repos/Vidvox/ISF-Files/')));
  assert.ok(calls.every(({ init }) => init.redirect === 'manual'));
  assert.ok(calls.some(({ init }) => init.headers.Authorization === 'Bearer test-token-must-not-escape'));

  const second = await service.syncStep({ provider: 'isf', limit: 10 });
  assert.equal(second.status, 'complete');
  assert.equal(second.processed, 1);
  assert.equal(store.resources.size, 2);
  const third = await service.syncStep({ provider: 'isf', limit: 10 });
  assert.equal(third.processed, 0);
});

test('a new ISF revision keeps removed records through partial sync and reconciles only after completion', async () => {
  const oldRevision = '3'.repeat(40);
  const newRevision = '4'.repeat(40);
  const commitUrl = 'https://api.github.com/repos/Vidvox/ISF-Files/commits/master';
  const retiredPath = 'ISF/Retired.fs';
  const currentPath = 'ISF/Current.fs';
  const laterPath = 'ISF/Later.fs';
  let currentRevision = oldRevision;
  const routes = new Map([
    [commitUrl, () => jsonResponse({ sha: currentRevision })],
    [`https://api.github.com/repos/Vidvox/ISF-Files/git/trees/${oldRevision}?recursive=1`, jsonResponse({ truncated: false, tree: [
      { type: 'blob', path: retiredPath, sha: 'a'.repeat(40) },
    ] })],
    [`https://api.github.com/repos/Vidvox/ISF-Files/git/trees/${newRevision}?recursive=1`, jsonResponse({ truncated: false, tree: [
      { type: 'blob', path: currentPath, sha: 'b'.repeat(40) },
      { type: 'blob', path: laterPath, sha: 'c'.repeat(40) },
    ] })],
    [`https://api.github.com/repos/Vidvox/ISF-Files/contents/${retiredPath}?ref=${oldRevision}`, jsonResponse(githubFilePayload(ISF_SECOND_FRAGMENT))],
    [`https://api.github.com/repos/Vidvox/ISF-Files/contents/${currentPath}?ref=${newRevision}`, jsonResponse(githubFilePayload(ISF_SECOND_FRAGMENT))],
    [`https://api.github.com/repos/Vidvox/ISF-Files/contents/${laterPath}?ref=${newRevision}`, jsonResponse(githubFilePayload(ISF_SECOND_FRAGMENT))],
  ]);
  const { service, store } = serviceWith(routeFetch(routes, []));

  const initial = await service.syncStep({ provider: 'isf', limit: 10 });
  assert.equal(initial.status, 'complete');
  assert.ok(store.getResource({ provider: 'isf', id: retiredPath }));

  currentRevision = newRevision;
  const partial = await service.syncStep({ provider: 'isf', limit: 1 });
  assert.equal(partial.status, 'partial');
  assert.equal(store.getSyncState('isf').status, 'partial');
  assert.ok(store.getResource({ provider: 'isf', id: retiredPath }), 'partial work must not remove the prior revision');

  const complete = await service.syncStep({ provider: 'isf', limit: 1 });
  assert.equal(complete.status, 'complete');
  assert.equal(store.getResource({ provider: 'isf', id: retiredPath }), null);
  assert.ok(store.getResource({ provider: 'isf', id: currentPath }));
  assert.ok(store.getResource({ provider: 'isf', id: laterPath }));
});

test('ISF rejects incomplete, malformed, and zero-eligible GitHub trees before any destructive reconciliation', async () => {
  const oldRevision = '6'.repeat(40);
  const revision = '7'.repeat(40);
  const commitUrl = 'https://api.github.com/repos/Vidvox/ISF-Files/commits/master';
  const treeUrl = `https://api.github.com/repos/Vidvox/ISF-Files/git/trees/${revision}?recursive=1`;
  const retiredPath = 'ISF/Retired.fs';
  const validEntry = { type: 'blob', path: 'ISF/Current.fs', sha: 'b'.repeat(40) };
  const scenarios = [
    ['truncated response', { truncated: true, tree: [validEntry] }],
    ['missing explicit truncation flag', { tree: [validEntry] }],
    ['malformed entry', { truncated: false, tree: [{ type: 'blob', path: 'ISF/../Escape.fs', sha: 'c'.repeat(40) }] }],
    ['empty tree', { truncated: false, tree: [] }],
    ['tree with no eligible ISF fragment', { truncated: false, tree: [{ type: 'blob', path: 'README.md', sha: 'd'.repeat(40) }] }],
  ];

  for (const [label, treePayload] of scenarios) {
    const store = new SourceStore(':memory:');
    try {
      store.upsertResource(makeIsfRecord(retiredPath, oldRevision));
      store.setSyncState('isf', {
        revision: oldRevision,
        cursor: '1',
        total: 1,
        status: 'complete',
        updatedAt: '2026-09-04T00:00:00.000Z',
      });
      const calls = [];
      const { service } = serviceWith(routeFetch(new Map([
        [commitUrl, jsonResponse({ sha: revision })],
        [treeUrl, jsonResponse(treePayload)],
      ]), calls), store);

      const result = await service.syncStep({ provider: 'isf', limit: 10 });
      assert.equal(result.status, 'error', label);
      assert.equal(result.error.code, 'upstream_schema_changed', label);
      assert.equal(result.error.resumable, true, label);
      assert.ok(store.getResource({ provider: 'isf', id: retiredPath }), label);
      assert.equal(store.getSyncState('isf').revision, oldRevision, label);
      assert.equal(calls.some(({ url }) => url.includes('/contents/')), false, label);
      assert.equal(store.status().counts.providerSyncLeases, 0, `${label} releases its lease`);
    } finally {
      store.close();
    }
  }
});

test('ISF rejects a same-revision total mismatch before resource writes or pruning', async () => {
  const revision = '8'.repeat(40);
  const path = 'ISF/Only.fs';
  const commitUrl = 'https://api.github.com/repos/Vidvox/ISF-Files/commits/master';
  const treeUrl = `https://api.github.com/repos/Vidvox/ISF-Files/git/trees/${revision}?recursive=1`;
  const store = new SourceStore(':memory:');
  try {
    store.upsertResource(makeIsfRecord(path, revision));
    store.setSyncState('isf', {
      revision,
      cursor: '1',
      total: 2,
      status: 'partial',
      updatedAt: '2026-09-04T00:00:00.000Z',
    });
    const calls = [];
    const { service } = serviceWith(routeFetch(new Map([
      [commitUrl, jsonResponse({ sha: revision })],
      [treeUrl, jsonResponse({ truncated: false, tree: [
        { type: 'blob', path, sha: 'e'.repeat(40) },
      ] })],
    ]), calls), store);

    const result = await service.syncStep({ provider: 'isf', limit: 10 });
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'upstream_schema_changed');
    assert.equal(result.error.resumable, true);
    assert.ok(store.getResource({ provider: 'isf', id: path }));
    assert.equal(store.getSyncState('isf').total, 2);
    assert.equal(calls.some(({ url }) => url.includes('/contents/')), false);
    assert.equal(store.status().counts.providerSyncLeases, 0);
  } finally {
    store.close();
  }
});

test('ISF reconciliation storage failure is resumable and completes safely on retry', async () => {
  const oldRevision = '9'.repeat(40);
  const revision = 'a'.repeat(40);
  const retiredPath = 'ISF/Retired.fs';
  const currentPath = 'ISF/Current.fs';
  const commitUrl = 'https://api.github.com/repos/Vidvox/ISF-Files/commits/master';
  const treeUrl = `https://api.github.com/repos/Vidvox/ISF-Files/git/trees/${revision}?recursive=1`;
  const currentUrl = `https://api.github.com/repos/Vidvox/ISF-Files/contents/${currentPath}?ref=${revision}`;
  const store = new SourceStore(':memory:');
  try {
    store.upsertResource(makeIsfRecord(retiredPath, oldRevision));
    store.setSyncState('isf', {
      revision: oldRevision,
      cursor: '1',
      total: 1,
      status: 'complete',
      updatedAt: '2026-09-04T00:00:00.000Z',
    });
    const { service } = serviceWith(routeFetch(new Map([
      [commitUrl, jsonResponse({ sha: revision })],
      [treeUrl, jsonResponse({ truncated: false, tree: [
        { type: 'blob', path: currentPath, sha: 'b'.repeat(40) },
      ] })],
      [currentUrl, jsonResponse(githubFilePayload(ISF_SECOND_FRAGMENT))],
    ]), []), store);
    store.db.exec(`
      CREATE TRIGGER force_isf_reconciliation_failure
      BEFORE DELETE ON resources
      WHEN OLD.provider = 'isf' AND OLD.resource_id = '${retiredPath}'
      BEGIN
        SELECT RAISE(ABORT, 'forced reconciliation failure');
      END;
    `);

    const failed = await service.syncStep({ provider: 'isf', limit: 10 });
    assert.equal(failed.status, 'error');
    assert.equal(failed.error.code, 'store_error');
    assert.equal(failed.error.resumable, true);
    assert.ok(store.getResource({ provider: 'isf', id: retiredPath }));
    assert.ok(store.getResource({ provider: 'isf', id: currentPath }));
    assert.equal(store.getSyncState('isf').revision, revision);
    assert.equal(store.getSyncState('isf').status, 'partial');
    assert.equal(store.status().counts.providerSyncLeases, 0, 'the failed completion releases its run token');

    store.db.exec('DROP TRIGGER force_isf_reconciliation_failure');
    const retried = await service.syncStep({ provider: 'isf', limit: 10 });
    assert.equal(retried.status, 'complete');
    assert.equal(retried.processed, 0, 'the retry resumes the stored cursor rather than re-fetching the current item');
    assert.equal(store.getResource({ provider: 'isf', id: retiredPath }), null);
    assert.ok(store.getResource({ provider: 'isf', id: currentPath }));
    assert.equal(store.getSyncState('isf').status, 'complete');
    assert.equal(store.status().counts.providerSyncLeases, 0);
  } finally {
    store.close();
  }
});

test('ISF state-write failure after a durable resource is resumable, releases its lease, and retries the same step', async () => {
  const revision = 'b'.repeat(40);
  const path = 'ISF/StateFailure.fs';
  const commitUrl = 'https://api.github.com/repos/Vidvox/ISF-Files/commits/master';
  const treeUrl = `https://api.github.com/repos/Vidvox/ISF-Files/git/trees/${revision}?recursive=1`;
  const fileUrl = `https://api.github.com/repos/Vidvox/ISF-Files/contents/${path}?ref=${revision}`;
  const store = new SourceStore(':memory:');
  try {
    const { service } = serviceWith(routeFetch(new Map([
      [commitUrl, jsonResponse({ sha: revision })],
      [treeUrl, jsonResponse({ truncated: false, tree: [
        { type: 'blob', path, sha: 'c'.repeat(40) },
      ] })],
      [fileUrl, jsonResponse(githubFilePayload(ISF_SECOND_FRAGMENT))],
    ]), []), store);
    store.db.exec(`
      CREATE TRIGGER force_isf_sync_state_failure
      BEFORE INSERT ON provider_sync_state
      WHEN NEW.provider = 'isf'
      BEGIN
        SELECT RAISE(ABORT, 'forced sync state write failure');
      END;
    `);

    const failed = await service.syncStep({ provider: 'isf', limit: 10 });
    assert.equal(failed.status, 'error');
    assert.equal(failed.error.code, 'store_error');
    assert.equal(failed.error.resumable, true);
    assert.ok(store.getResource({ provider: 'isf', id: path }), 'the resource write committed before the state failure');
    assert.equal(store.getSyncState('isf'), null, 'the failed state transaction did not advance the cursor');
    assert.equal(store.status().counts.providerSyncLeases, 0, 'the failed state write releases its run token');

    store.db.exec('DROP TRIGGER force_isf_sync_state_failure');
    const retried = await service.syncStep({ provider: 'isf', limit: 10 });
    assert.equal(retried.status, 'complete');
    assert.equal(retried.processed, 1, 'the unchanged cursor safely replays the idempotent resource write');
    assert.equal(store.getSyncState('isf').revision, revision);
    assert.equal(store.getSyncState('isf').status, 'complete');
    assert.equal(store.status().counts.providerSyncLeases, 0);
  } finally {
    store.close();
  }
});

test('a successful partial ISF sync reports a safe resumable error when lease release throws or returns false', async () => {
  const revision = 'd'.repeat(40);
  const firstPath = 'ISF/First.fs';
  const commitUrl = 'https://api.github.com/repos/Vidvox/ISF-Files/commits/master';
  const treeUrl = `https://api.github.com/repos/Vidvox/ISF-Files/git/trees/${revision}?recursive=1`;
  const firstUrl = `https://api.github.com/repos/Vidvox/ISF-Files/contents/${firstPath}?ref=${revision}`;
  const store = new MemorySourceStore();
  const { service } = serviceWith(routeFetch(new Map([
    [commitUrl, jsonResponse({ sha: revision })],
    [treeUrl, jsonResponse({ truncated: false, tree: [
      { type: 'blob', path: firstPath, sha: 'e'.repeat(40) },
      { type: 'blob', path: 'ISF/Second.fs', sha: 'f'.repeat(40) },
    ] })],
    [firstUrl, jsonResponse(githubFilePayload(ISF_SECOND_FRAGMENT))],
  ]), []), store);
  store.releaseProviderSyncRun = () => {
    throw new Error('forced lease release failure');
  };

  const result = await service.syncStep({ provider: 'isf', limit: 1 });
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'store_error');
  assert.equal(result.error.resumable, true);
  assert.equal(store.getSyncState('isf').status, 'partial');
  assert.equal(store.getSyncState('isf').cursor, '1');
  assert.ok(store.getResource({ provider: 'isf', id: firstPath }));

  const staleStore = new MemorySourceStore();
  const { service: staleService } = serviceWith(routeFetch(new Map([
    [commitUrl, jsonResponse({ sha: revision })],
    [treeUrl, jsonResponse({ truncated: false, tree: [
      { type: 'blob', path: firstPath, sha: 'e'.repeat(40) },
      { type: 'blob', path: 'ISF/Second.fs', sha: 'f'.repeat(40) },
    ] })],
    [firstUrl, jsonResponse(githubFilePayload(ISF_SECOND_FRAGMENT))],
  ]), []), staleStore);
  staleStore.releaseProviderSyncRun = () => false;
  const stale = await staleService.syncStep({ provider: 'isf', limit: 1 });
  assert.equal(stale.status, 'error');
  assert.equal(stale.error.code, 'sync_in_progress');
  assert.equal(stale.error.retryable, true);
  assert.equal(stale.error.resumable, true);
  assert.equal(staleStore.getSyncState('isf').status, 'partial');

  const bookStore = new MemorySourceStore();
  const { service: bookService } = serviceWith(async () => {
    throw new Error('Book sync is offline and must not fetch');
  }, bookStore);
  bookStore.releaseProviderSyncRun = () => {
    throw new Error('forced lease release failure');
  };
  const book = await bookService.syncStep({ provider: 'book-of-shaders', limit: 1 });
  assert.equal(book.status, 'error');
  assert.equal(book.error.code, 'store_error');
  assert.equal(book.error.resumable, true);
  assert.equal(bookStore.getSyncState('book-of-shaders').status, 'partial');
});

test('lease-release failure does not mask upstream or durable-store primary sync errors', async () => {
  const commitUrl = 'https://api.github.com/repos/Vidvox/ISF-Files/commits/master';

  const upstreamStore = new MemorySourceStore();
  const { service: upstreamService } = serviceWith(routeFetch(new Map([
    [commitUrl, jsonResponse({ message: 'slow down' }, 429)],
  ]), []), upstreamStore);
  upstreamStore.releaseProviderSyncRun = () => false;
  const upstream = await upstreamService.syncStep({ provider: 'isf', limit: 1 });
  assert.equal(upstream.status, 'error');
  assert.equal(upstream.error.code, 'rate_limited');
  assert.equal(upstream.error.retryable, true);
  assert.equal(upstream.error.resumable, true);

  const revision = 'a'.repeat(40);
  const path = 'ISF/WriteFailure.fs';
  const treeUrl = `https://api.github.com/repos/Vidvox/ISF-Files/git/trees/${revision}?recursive=1`;
  const fileUrl = `https://api.github.com/repos/Vidvox/ISF-Files/contents/${path}?ref=${revision}`;
  const persistenceStore = new MemorySourceStore();
  const { service: persistenceService } = serviceWith(routeFetch(new Map([
    [commitUrl, jsonResponse({ sha: revision })],
    [treeUrl, jsonResponse({ truncated: false, tree: [
      { type: 'blob', path, sha: 'b'.repeat(40) },
    ] })],
    [fileUrl, jsonResponse(githubFilePayload(ISF_SECOND_FRAGMENT))],
  ]), []), persistenceStore);
  persistenceStore.upsertResourceForProviderSync = () => {
    throw new Error('forced durable resource write failure');
  };
  persistenceStore.releaseProviderSyncRun = () => {
    throw new Error('forced lease release failure');
  };
  const persistence = await persistenceService.syncStep({ provider: 'isf', limit: 1 });
  assert.equal(persistence.status, 'error');
  assert.equal(persistence.error.code, 'store_error');
  assert.equal(persistence.error.resumable, true);
  assert.equal(persistenceStore.getSyncState('isf'), null);
});

test('ISF claims its lease before network, resumes an expired partial run, and rejects the late stale owner', async () => {
  await withSharedDatabase(async (databasePath) => {
    let clockMs = 1_000_000;
    const options = {
      path: databasePath,
      providerSyncLeaseMs: 1_000,
      syncClock: () => clockMs,
    };
    const firstStore = new SourceStore(options);
    const secondStore = new SourceStore(options);
    const oldRevision = 'b'.repeat(40);
    const revision = 'c'.repeat(40);
    const retiredPath = 'ISF/Retired.fs';
    const firstPath = 'ISF/First.fs';
    const secondPath = 'ISF/Second.fs';
    const commitUrl = 'https://api.github.com/repos/Vidvox/ISF-Files/commits/master';
    const treeUrl = `https://api.github.com/repos/Vidvox/ISF-Files/git/trees/${revision}?recursive=1`;
    const firstUrl = `https://api.github.com/repos/Vidvox/ISF-Files/contents/${firstPath}?ref=${revision}`;
    const secondUrl = `https://api.github.com/repos/Vidvox/ISF-Files/contents/${secondPath}?ref=${revision}`;
    let markSecondFileStarted;
    const secondFileStarted = new Promise((resolve) => { markSecondFileStarted = resolve; });
    let releaseSecondFile;
    const delayedSecondFile = new Promise((resolve) => { releaseSecondFile = resolve; });
    const firstCalls = [];
    const secondCalls = [];
    try {
      firstStore.upsertResource(makeIsfRecord(retiredPath, oldRevision));
      firstStore.setSyncState('isf', {
        revision: oldRevision,
        cursor: '1',
        total: 1,
        status: 'complete',
        updatedAt: '2026-09-04T00:00:00.000Z',
      });
      const { service: firstService } = serviceWith(async (url, init) => {
        firstCalls.push({ url, init });
        if (url === commitUrl) return jsonResponse({ sha: revision });
        if (url === treeUrl) {
          return jsonResponse({ truncated: false, tree: [
            { type: 'blob', path: firstPath, sha: 'd'.repeat(40) },
            { type: 'blob', path: secondPath, sha: 'e'.repeat(40) },
          ] });
        }
        if (url === firstUrl) return jsonResponse(githubFilePayload(ISF_SECOND_FRAGMENT));
        if (url === secondUrl) {
          markSecondFileStarted();
          return delayedSecondFile;
        }
        throw new Error(`unexpected first-store URL ${url}`);
      }, firstStore);
      const { service: secondService } = serviceWith(async (url, init) => {
        secondCalls.push({ url, init });
        if (url === commitUrl) return jsonResponse({ sha: revision });
        if (url === treeUrl) {
          return jsonResponse({ truncated: false, tree: [
            { type: 'blob', path: firstPath, sha: 'd'.repeat(40) },
            { type: 'blob', path: secondPath, sha: 'e'.repeat(40) },
          ] });
        }
        if (url === secondUrl) return jsonResponse(githubFilePayload(ISF_FRAGMENT));
        if (url === firstUrl) throw new Error('the resumed run must not fetch the already persisted first item');
        throw new Error(`unexpected second-store URL ${url}`);
      }, secondStore);

      const staleRun = firstService.syncStep({ provider: 'isf', limit: 10 });
      await secondFileStarted;
      assert.equal(firstStore.getSyncState('isf').cursor, '1', 'the first owner persisted a resumable partial cursor');

      const busy = await secondService.syncStep({ provider: 'isf', limit: 10 });
      assert.equal(busy.status, 'error');
      assert.equal(busy.error.code, 'sync_in_progress');
      assert.equal(busy.error.resumable, true);
      assert.equal(secondCalls.length, 0, 'a competing run is rejected before any upstream request');

      clockMs += 1_000;
      const resumed = await secondService.syncStep({ provider: 'isf', limit: 10 });
      assert.equal(resumed.status, 'complete');
      assert.equal(resumed.processed, 1, 'the expiry takeover resumes at the stored second item');
      assert.equal(secondCalls.filter(({ url }) => url === firstUrl).length, 0);
      assert.equal(secondCalls.filter(({ url }) => url === secondUrl).length, 1);

      releaseSecondFile(jsonResponse(githubFilePayload(ISF_SECOND_FRAGMENT)));
      const stale = await staleRun;
      assert.equal(stale.status, 'error');
      assert.equal(stale.error.code, 'sync_in_progress');
      assert.equal(stale.error.resumable, true);
      assert.equal(firstStore.getResource({ provider: 'isf', id: retiredPath }), null);
      assert.ok(firstStore.getResource({ provider: 'isf', id: firstPath }));
      assert.ok(firstStore.getResource({ provider: 'isf', id: secondPath }));
      assert.equal(firstStore.getSyncState('isf').revision, revision);
      assert.equal(firstStore.getSyncState('isf').status, 'complete');
      assert.equal(firstStore.status().counts.providerSyncLeases, 0);
    } finally {
      firstStore.close();
      secondStore.close();
    }
  });
});

test('ISF treats true and positive numeric PERSISTENT pass values as persistent buffers', () => {
  const record = normalizeIsfResource({
    ref: { provider: 'isf', id: 'ISF/Persistent.fs' },
    canonicalUrl: 'https://github.com/Vidvox/ISF-Files/blob/test/ISF/Persistent.fs',
    path: 'ISF/Persistent.fs',
    fragmentSource: `/*
{
  "ISFVSN": "2",
  "PASSES": [
    { "TARGET": "boolean", "PERSISTENT": true },
    { "TARGET": "numeric", "PERSISTENT": 1 },
    { "TARGET": "zero", "PERSISTENT": 0 },
    { "TARGET": "negative", "PERSISTENT": -1 }
  ]
}
*/
void main() {}`,
    commit: 'test',
    now: () => 0,
  });
  assert.equal(record.metadata.passes[0].PERSISTENT, true);
  assert.equal(record.metadata.passes[1].PERSISTENT, 1);
  assert.deepEqual(record.metadata.hostRequirements, ['multi-pass', 'persistent-buffer']);
});

test('WebGL Fundamentals sync prefers Chinese lessons, excludes non-lessons, and retains BSD provenance', async () => {
  const calls = [];
  const commitUrl = 'https://api.github.com/repos/gfxfundamentals/webgl-fundamentals/commits/master';
  const treeUrl = `https://api.github.com/repos/gfxfundamentals/webgl-fundamentals/git/trees/${WEBGL_COMMIT}?recursive=1`;
  const chinesePath = 'webgl/lessons/zh_cn/lesson-one.md';
  const otherPath = 'webgl/lessons/lesson-two.md';
  const trailingPath = 'webgl/lessons/lesson-with-trailing-.md';
  const routes = new Map([
    [commitUrl, jsonResponse({ sha: WEBGL_COMMIT })],
    [treeUrl, jsonResponse({ truncated: false, tree: [
      { type: 'blob', path: 'webgl/lessons/lesson-one.md', sha: '1'.repeat(40) },
      { type: 'blob', path: chinesePath, sha: '2'.repeat(40) },
      { type: 'blob', path: otherPath, sha: '3'.repeat(40) },
      { type: 'blob', path: trailingPath, sha: '6'.repeat(40) },
      { type: 'blob', path: 'webgl/lessons/3rdparty/ignore.md', sha: '4'.repeat(40) },
      { type: 'blob', path: 'webgl/assets/ignore.md', sha: '5'.repeat(40) },
    ] })],
    [`https://api.github.com/repos/gfxfundamentals/webgl-fundamentals/contents/${chinesePath}?ref=${WEBGL_COMMIT}`, jsonResponse(githubFilePayload(WEBGL_CHINESE))],
    [`https://api.github.com/repos/gfxfundamentals/webgl-fundamentals/contents/${otherPath}?ref=${WEBGL_COMMIT}`, jsonResponse(githubFilePayload(WEBGL_OTHER))],
    [`https://api.github.com/repos/gfxfundamentals/webgl-fundamentals/contents/${trailingPath}?ref=${WEBGL_COMMIT}`, jsonResponse(githubFilePayload(WEBGL_TRAILING))],
  ]);
  const { service, store } = serviceWith(routeFetch(routes, calls));

  const result = await service.syncStep({ provider: 'webgl-fundamentals', limit: 10 });
  assert.equal(result.status, 'complete');
  assert.equal(result.processed, 3);
  const chineseRef = service.resolveLink('https://webglfundamentals.org/webgl/lessons/zh_cn/lesson-one.html').ref;
  const otherRef = service.resolveLink('https://webglfundamentals.org/webgl/lessons/lesson-two.html').ref;
  const englishOneRef = service.resolveLink('https://webglfundamentals.org/webgl/lessons/lesson-one.html').ref;
  const trailingRef = service.resolveLink('https://webglfundamentals.org/webgl/lessons/lesson-with-trailing-.html').ref;
  const chinese = store.getResource(chineseRef);
  assert.equal(chinese.language, 'zh-CN');
  assert.equal(chinese.rights.spdx, 'BSD-3-Clause');
  assert.deepEqual(chinese.authorization, { basis: 'repository-license', assertedBy: 'official-provider-policy' });
  assert.equal(chinese.title, '官方中文标题');
  assert.equal(chinese.description, '官方中文摘要优先于 Markdown 标题。');
  assert.equal(store.getResource(englishOneRef), null);
  assert.equal(store.getResource(otherRef).blobs[0].body, WEBGL_OTHER);
  assert.equal(store.getResource(trailingRef).blobs[0].body, WEBGL_TRAILING);
  assert.equal(store.getSyncState('webgl-fundamentals').cursor, '3');
  assert.equal(store.getSyncState('webgl-fundamentals').status, 'complete');
  assert.ok(calls.every(({ url }) => !url.includes('3rdparty') && !url.includes('/assets/')));
  void WEBGL_ENGLISH;
});

test('WebGL completion removes a previously cached English fallback when Chinese becomes eligible', async () => {
  const oldRevision = '5'.repeat(40);
  const commitUrl = 'https://api.github.com/repos/gfxfundamentals/webgl-fundamentals/commits/master';
  const chinesePath = 'webgl/lessons/zh_cn/lesson-one.md';
  const englishRef = { provider: 'webgl-fundamentals', id: 'lesson-one' };
  const routes = new Map([
    [commitUrl, jsonResponse({ sha: WEBGL_COMMIT })],
    [`https://api.github.com/repos/gfxfundamentals/webgl-fundamentals/git/trees/${WEBGL_COMMIT}?recursive=1`, jsonResponse({ truncated: false, tree: [
      { type: 'blob', path: 'webgl/lessons/lesson-one.md', sha: 'd'.repeat(40) },
      { type: 'blob', path: chinesePath, sha: 'e'.repeat(40) },
    ] })],
    [`https://api.github.com/repos/gfxfundamentals/webgl-fundamentals/contents/${chinesePath}?ref=${WEBGL_COMMIT}`, jsonResponse(githubFilePayload(WEBGL_CHINESE))],
  ]);
  const { service, store } = serviceWith(routeFetch(routes, []));
  store.upsertResource({
    ref: englishRef,
    title: 'Previously cached English fallback',
    contentPolicy: 'full_text',
    blobs: [{ role: 'lesson', mimeType: 'text/markdown', body: WEBGL_ENGLISH }],
  });
  store.setSyncState('webgl-fundamentals', {
    revision: oldRevision,
    cursor: '1',
    total: 1,
    status: 'complete',
    updatedAt: '2026-09-04T00:00:00.000Z',
  });

  const result = await service.syncStep({ provider: 'webgl-fundamentals', limit: 10 });
  const chineseRef = service.resolveLink('https://webglfundamentals.org/webgl/lessons/zh_cn/lesson-one.html').ref;
  assert.equal(result.status, 'complete');
  assert.equal(store.getResource(englishRef), null);
  assert.ok(store.getResource(chineseRef));
});

test('Book of Shaders seeds an offline original topic index with no page bodies or network calls', async () => {
  let calls = 0;
  const { service, store } = serviceWith(async () => {
    calls += 1;
    throw new Error('Book of Shaders must not crawl page text');
  });
  const result = await service.syncStep({ provider: 'book-of-shaders', limit: 10 });
  assert.equal(result.status, 'complete');
  assert.equal(result.offline, true);
  assert.equal(calls, 0);
  assert.equal(store.resources.size, 6);
  for (const record of store.resources.values()) {
    assert.equal(record.contentPolicy, 'link_only');
    assert.equal(record.blobs.length, 0);
    assert.equal(record.metadata.bodyBytes, 0);
    assert.equal(record.metadata.summaryLanguage, 'zh-CN');
    assert.deepEqual(record.authorization, { basis: 'reference-only', assertedBy: 'built-in-provider-policy' });
  }
  const englishFallbacks = [...store.resources.values()].filter((record) => record.metadata.sourceLanguage === 'en');
  assert.deepEqual(englishFallbacks.map((record) => record.canonicalUrl).sort(), [
    'https://thebookofshaders.com/16/?lan=en',
    'https://thebookofshaders.com/18/?lan=en',
  ]);
  assert.equal([...store.resources.values()].filter((record) => record.metadata.sourceLanguage === 'zh-CN').length, 4);
});

test('Book completion prunes retired built-in topics while retaining user-provided chapter links', async () => {
  const store = new SourceStore(':memory:');
  try {
    const retiredRef = { provider: 'book-of-shaders', id: 'retired-built-in-topic' };
    store.upsertResource({
      ref: retiredRef,
      kind: 'knowledge',
      title: 'Retired built-in topic',
      description: 'Old generated topic index entry.',
      tags: ['book'],
      canonicalUrl: 'https://thebookofshaders.com/99/?lan=en',
      rights: null,
      provenance: { acquisition: 'built-in-original-topic-index' },
      authorization: { basis: 'reference-only', assertedBy: 'built-in-provider-policy' },
      contentPolicy: 'link_only',
      metadata: {},
      blobs: [],
    });
    const { service } = serviceWith(async () => {
      throw new Error('Book sync must remain offline');
    }, store);
    const imported = await service.importLink({
      url: 'https://thebookofshaders.com/05/?lan=ch',
      authorizationBasis: 'reference-only',
    });
    assert.equal(imported.status, 'ok');
    const userRef = imported.ref;

    const synced = await service.syncStep({ provider: 'book-of-shaders', limit: 10 });
    assert.equal(synced.status, 'complete');
    assert.equal(store.getResource(retiredRef), null);
    assert.ok(store.getResource(userRef), 'sync-managed reconciliation must not delete user-provided links');
  } finally {
    store.close();
  }
});

test('Godot parses only scoped license DOM, captures vcard authors, and cross-checks only a leading source header after authorization', async () => {
  const calls = [];
  const pageUrl = 'https://godotshaders.com/shader/fixture-shader/';
  const apiUrl = 'https://godotshaders.com/wp-json/shader_data/shader/123';
  const { service } = serviceWith(routeFetch(new Map([
    [pageUrl, textResponse([
      '<body class="postid-123">',
      '<article id="post-123" class="post shader_license-mit">',
      '<h1>Fixture shader</h1>',
      '<span class="author vcard"><a class="url fn n" href="/user/fixture">Fixture Author</a></span>',
      '<p>A third-party discussion cites GPL-3.0-only and Creative Commons Zero.</p>',
      '<div class="shader_license_block"><strong>MIT License</strong></div>',
      '</article>',
      '<footer>GNU General Public License version 3 appears in this unrelated footer.</footer>',
      '</body>',
    ].join(''))],
    [apiUrl, jsonResponse({ id: 123, title: 'Fixture shader', shader_type: 'canvas_item', code: '// SPDX-License-Identifier: MIT\nshader_type canvas_item;\nvoid fragment() {}' })],
  ]), calls));

  const referenceOnly = await service.importLink({ url: pageUrl, authorizationBasis: 'reference-only' });
  assert.equal(referenceOnly.status, 'ok');
  assert.equal(referenceOnly.resource.rights.spdx, null);
  assert.equal(referenceOnly.resource.rights.reviewRequired, true);
  assert.equal(referenceOnly.resource.author, 'Fixture Author');
  assert.deepEqual(referenceOnly.resource.metadata.licenseBlockLicense, ['MIT']);
  assert.deepEqual(referenceOnly.resource.metadata.articleClassLicense, ['MIT']);
  assert.equal(referenceOnly.resource.metadata.licenseConflict, false);
  assert.equal(referenceOnly.resource.blobs.length, 0);
  assert.equal(referenceOnly.resource.contentPolicy, 'metadata_only');
  assert.deepEqual(referenceOnly.resource.authorization, { basis: 'reference-only', assertedBy: 'caller' });
  assert.equal(referenceOnly.resource.metadata.externalAssetsDownloaded, false);
  assert.equal(referenceOnly.resource.metadata.externalAssetRequired, null);
  assert.equal(referenceOnly.resource.metadata.sourceFetched, false);
  assert.equal(referenceOnly.resource.metadata.sourceCrossCheckPending, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, pageUrl);

  const repositoryLicense = await service.importLink({ url: pageUrl, authorizationBasis: 'repository-license' });
  assert.equal(repositoryLicense.status, 'ok');
  assert.equal(repositoryLicense.resource.blobs.length, 0);
  assert.equal(repositoryLicense.resource.metadata.sourceFetched, false);
  assert.equal(calls.length, 2, 'a repository license does not permit fetching a Godot user work source');

  const result = await service.importLink({ url: pageUrl, authorizationBasis: 'licensed' });
  assert.equal(result.status, 'ok');
  assert.equal(result.resource.blobs.length, 1);
  assert.equal(result.resource.contentPolicy, 'full_source');
  assert.equal(result.resource.rights.spdx, 'MIT');
  assert.deepEqual(result.resource.metadata.sourceHeaderLicense, ['MIT']);
  assert.equal(result.resource.metadata.licenseConflict, false);
  assert.deepEqual(result.resource.authorization, { basis: 'licensed', assertedBy: 'caller' });
  assert.equal(calls.length, 4);
  assert.equal(calls.filter(({ url }) => url === apiUrl).length, 1);
  assert.ok(calls.every(({ url }) => url === pageUrl || url === apiUrl));
  assert.ok(calls.every(({ init }) => init.redirect === 'manual'));
});

test('Godot accepts license evidence only from the target article and ignores comments, scripts, styles, templates, and related cards', async () => {
  const calls = [];
  const pageUrl = 'https://godotshaders.com/shader/scoped-license/';
  const apiUrl = 'https://godotshaders.com/wp-json/shader_data/shader/166';
  const { service } = serviceWith(routeFetch(new Map([
    [pageUrl, textResponse([
      '<body class="single-shader postid-166">',
      '<!-- <article id="post-166" class="shader_license-gpl"><div class="shader_license_block">GPL-3.0-only</div></article> -->',
      '<script>const template = "<article id=\\"post-166\\" class=\\"shader_license-gpl\\"></article>";</script>',
      '<style>.shader_license-gpl::before { content: "GPL-3.0-only"; }</style>',
      '<template><article id="post-166" class="shader_license-gpl"><div class="shader_license_block">GPL-3.0-only</div></article></template>',
      '<article id="post-166" class="post shader_license-mit">',
      '<h1>Scoped target</h1>',
      '<span class="author vcard"><a class="url fn n">Target Author</a></span>',
      '<div class="shader_license_block">MIT License</div>',
      '<section class="related-card"><article id="post-999" class="shader_license-gpl"><h1>Related card</h1><div class="shader_license_block">GPL-3.0-only</div></article></section>',
      '</article>',
      '</body>',
    ].join(''))],
    [apiUrl, jsonResponse({ id: 166, title: 'Scoped target', shader_type: 'canvas_item', code: '// SPDX-License-Identifier: MIT\nshader_type canvas_item;\nvoid fragment() {}' })],
  ]), calls));

  const result = await service.importLink({ url: pageUrl, authorizationBasis: 'licensed' });
  assert.equal(result.status, 'ok');
  assert.equal(result.resource.author, 'Target Author');
  assert.deepEqual(result.resource.metadata.pageLicense, ['MIT']);
  assert.deepEqual(result.resource.metadata.licenseBlockLicense, ['MIT']);
  assert.deepEqual(result.resource.metadata.articleClassLicense, ['MIT']);
  assert.equal(result.resource.metadata.licenseConflict, false);
  assert.equal(result.resource.metadata.sourceCached, true);
  assert.equal(result.resource.blobs.length, 1);
  assert.equal(calls.length, 2);
});

test('Godot tokenizer ignores pseudo-tags in attributes and inert raw-text containers', async () => {
  const cases = [
    {
      pageUrl: 'https://godotshaders.com/shader/attribute-fake-block/',
      postId: 176,
      html: '<article id="post-176" title="<div class=\'shader_license_block\'>MIT License</div>"><h1>Attribute fake</h1></article>',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/attribute-fake-target/',
      postId: 177,
      html: '<main data-template="<article id=\'post-177\' class=\'shader_license-mit\'><div class=\'shader_license_block\'>MIT License</div></article>"></main>',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/textarea-fake-target/',
      postId: 178,
      html: '<textarea><article id="post-178" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></textarea>',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/title-fake-target/',
      postId: 179,
      html: '<title><article id="post-179" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></title>',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/whitespace-fake-target/',
      postId: 180,
      html: '< article id="post-180" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article>',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/self-closing-template-fake-target/',
      postId: 187,
      html: '<template/><article id="post-187" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article>',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/self-closing-script-fake-target/',
      postId: 188,
      html: '<script/><article id="post-188" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article>',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/self-closing-textarea-fake-target/',
      postId: 189,
      html: '<textarea/><article id="post-189" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article>',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/nested-article-target/',
      postId: 190,
      html: '<article id="post-999"><article id="post-190" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></article>',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/select-option-fake-target/',
      postId: 191,
      html: '<select><option><article id="post-191" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></option></select>',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/svg-fake-target/',
      postId: 192,
      html: '<svg><article id="post-192" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></svg>',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/math-fake-target/',
      postId: 193,
      html: '<math><article id="post-193" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></math>',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/nested-body-fake-target/',
      postId: 194,
      html: '<select><option><body class="postid-194"><article id="post-194" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></body></option></select>',
      invalidPage: true,
    },
  ];
  const calls = [];
  const routes = new Map(cases.map((item) => [
    item.pageUrl,
    textResponse(`<body class="postid-${item.postId}">${item.html}</body>`),
  ]));
  const { service } = serviceWith(routeFetch(routes, calls));

  for (const item of cases) {
    const result = await service.importLink({ url: item.pageUrl, authorizationBasis: 'licensed' });
    if (item.invalidPage) {
      assert.equal(result.status, 'error');
      continue;
    }
    assert.equal(result.status, 'ok');
    assert.equal(result.resource.metadata.sourceFetched, false);
    assert.equal(result.resource.blobs.length, 0);
    assert.equal(result.resource.rights.reviewRequired, true);
  }
  assert.equal(calls.length, cases.length);
  assert.ok(calls.every(({ url }) => cases.some((item) => item.pageUrl === url)));
});

test('Godot invalid scoped blocks and unsupported license classes cannot be overridden by a matching source header', async () => {
  const cases = [
    { postId: 181, block: 'All rights reserved' },
    { postId: 182, block: 'MIT License. Personal use only; redistribution prohibited.' },
    { postId: 183, block: 'Not an MIT License' },
    { postId: 184, block: 'GPL-3.0-only', articleClass: 'shader_license-gpl3-or-later' },
    { postId: 185, block: '<template>MIT License</template>' },
    { postId: 186, block: '<article id="post-8">MIT License</article>' },
  ];
  const calls = [];
  const routes = new Map(cases.map((item) => {
    const articleClass = item.articleClass || 'shader_license-mit';
    return [
      `https://godotshaders.com/shader/invalid-license-${item.postId}/`,
      textResponse(`<body class="postid-${item.postId}"><article id="post-${item.postId}" class="${articleClass}"><div class="shader_license_block">${item.block}</div></article></body>`),
    ];
  }));
  const { service } = serviceWith(routeFetch(routes, calls));

  for (const item of cases) {
    const pageUrl = `https://godotshaders.com/shader/invalid-license-${item.postId}/`;
    const result = await service.importLink({ url: pageUrl, authorizationBasis: 'licensed' });
    assert.equal(result.status, 'ok');
    assert.equal(result.resource.metadata.sourceFetched, false);
    assert.equal(result.resource.metadata.sourceCached, false);
    assert.equal(result.resource.metadata.licenseConflict, true);
    assert.equal(result.resource.blobs.length, 0);
    assert.equal(result.resource.rights.reviewRequired, true);
    assert.equal(result.resource.metadata.invalidLicenseBlock, item.postId !== 184);
    assert.equal(result.resource.metadata.invalidArticleClass, item.postId === 184);
  }
  assert.equal(calls.length, cases.length);
});

test('ShaderFrog and Book of Shaders link imports retain caller authorization but remain link-only and offline', async () => {
  let calls = 0;
  const { service } = serviceWith(async () => {
    calls += 1;
    throw new Error('reference-only providers must not fetch');
  });
  const shaderfrog = await service.importLink({
    url: 'https://shaderfrog.com/editor/fixture123',
    authorizationBasis: 'author-permission',
  });
  assert.equal(shaderfrog.status, 'ok');
  assert.equal(shaderfrog.resource.contentPolicy, 'link_only');
  assert.equal(shaderfrog.resource.blobs.length, 0);
  assert.deepEqual(shaderfrog.resource.authorization, { basis: 'author-permission', assertedBy: 'caller' });
  const book = await service.importLink({
    url: 'https://thebookofshaders.com/07/?lan=ch',
    authorizationBasis: 'reference-only',
  });
  assert.equal(book.status, 'ok');
  assert.equal(book.resource.contentPolicy, 'link_only');
  assert.equal(book.resource.blobs.length, 0);
  assert.deepEqual(book.resource.authorization, { basis: 'reference-only', assertedBy: 'caller' });
  assert.equal(calls, 0);
});

test('Godot page and source-header conflicts stay metadata-only, while missing page licenses do not fetch source', async () => {
  const pageConflictUrl = 'https://godotshaders.com/shader/conflicting-page-license/';
  const headerConflictUrl = 'https://godotshaders.com/shader/dwadwad/';
  const headerConflictApiUrl = 'https://godotshaders.com/wp-json/shader_data/shader/457';
  const missingUrl = 'https://godotshaders.com/shader/no-scoped-license/';
  const calls = [];
  const { service } = serviceWith(routeFetch(new Map([
    [pageConflictUrl, textResponse('<body class="postid-456"><article id="post-456" class="shader_license-gpl"><h1>Page conflict</h1><div class="shader_license_block">MIT License</div></article></body>')],
    [headerConflictUrl, textResponse('<body class="postid-457"><article id="post-457" class="shader_license-cc0"><h1>Header conflict</h1><div class="shader_license_block">CC0 1.0</div></article></body>')],
    [headerConflictApiUrl, jsonResponse({ id: 457, title: 'Header conflict', shader_type: 'canvas_item', code: '// SPDX-License-Identifier: MIT\nshader_type canvas_item;\nvoid fragment() {}' })],
    [missingUrl, textResponse('<body class="postid-789"><article id="post-789"><h1>No scoped license</h1><p>MIT License in ordinary article prose must not be treated as the work license.</p></article></body>')],
  ]), calls));
  const pageConflict = await service.importLink({ url: pageConflictUrl, authorizationBasis: 'licensed' });
  assert.equal(pageConflict.status, 'ok');
  assert.equal(pageConflict.resource.rights.reviewRequired, true);
  assert.equal(pageConflict.resource.blobs.length, 0);
  assert.equal(pageConflict.resource.metadata.licenseConflict, true);
  assert.equal(pageConflict.resource.metadata.sourceFetched, false);
  const headerConflict = await service.importLink({ url: headerConflictUrl, authorizationBasis: 'licensed' });
  assert.equal(headerConflict.status, 'ok');
  assert.equal(headerConflict.resource.rights.reviewRequired, true);
  assert.equal(headerConflict.resource.blobs.length, 0);
  assert.equal(headerConflict.resource.contentPolicy, 'metadata_only');
  assert.equal(headerConflict.resource.metadata.licenseConflict, true);
  assert.equal(headerConflict.resource.metadata.sourceFetched, true);
  assert.equal(headerConflict.resource.metadata.sourceCached, false);
  assert.deepEqual(headerConflict.resource.metadata.sourceHeaderLicense, ['MIT']);
  const missing = await service.importLink({ url: missingUrl, authorizationBasis: 'licensed' });
  assert.equal(missing.status, 'ok');
  assert.equal(missing.resource.rights.reviewRequired, true);
  assert.equal(missing.resource.blobs.length, 0);
  assert.equal(missing.resource.metadata.sourceFetched, false);
  const shadertoy = await service.syncStep({ provider: 'shadertoy', limit: 1 });
  assert.equal(shadertoy.status, 'error');
  assert.equal(shadertoy.error.code, 'operation_not_supported');
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ url }) => url === pageConflictUrl || url === headerConflictUrl || url === headerConflictApiUrl || url === missingUrl));
});

test('Godot rejects composite, restrictive, and truncated source headers even when the page declares MIT', async () => {
  const oversizedBlockHeader = `/* ${'x'.repeat(16 * 1024)} All rights reserved */\nshader_type canvas_item;\nvoid fragment() {}`;
  const oversizedLineHeader = `${'// header filler\n'.repeat(1_200)}// All rights reserved\nshader_type canvas_item;\nvoid fragment() {}`;
  const cases = [
    {
      pageUrl: 'https://godotshaders.com/shader/strict-spdx-expression/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/458',
      postId: 458,
      code: '// SPDX-License-Identifier: MIT OR Apache-2.0\nshader_type canvas_item;\nvoid fragment() {}',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/restricted-source-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/459',
      postId: 459,
      code: '// All rights reserved. Do not redistribute or use. Non-commercial only.\nshader_type canvas_item;\nvoid fragment() {}',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/rights-are-reserved-mit-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/466',
      postId: 466,
      code: '// SPDX-License-Identifier: MIT\n// Rights are reserved. Redistribution requires written permission.\nshader_type canvas_item;\nvoid fragment() {}',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/mixed-freeform-license-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/468',
      postId: 468,
      code: '/* MIT License or Apache-2.0. */\nshader_type canvas_item;\nvoid fragment() {}',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/rights-hereby-reserved/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/469',
      postId: 469,
      code: '// SPDX-License-Identifier: MIT\n// All rights are hereby reserved.\nshader_type canvas_item;\nvoid fragment() {}',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/consent-only-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/470',
      postId: 470,
      code: "// SPDX-License-Identifier: MIT\n// Redistribution is permitted solely with author's written consent.\nshader_type canvas_item;\nvoid fragment() {}",
    },
    {
      pageUrl: 'https://godotshaders.com/shader/educational-only-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/471',
      postId: 471,
      code: '// SPDX-License-Identifier: MIT\n// Copying allowed for educational purposes only.\nshader_type canvas_item;\nvoid fragment() {}',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/second-license-line/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/472',
      postId: 472,
      code: '// SPDX-License-Identifier: MIT\n// Also licensed under CC0.\nshader_type canvas_item;\nvoid fragment() {}',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/second-block-comment/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/473',
      postId: 473,
      code: '/* MIT License */ /* All rights reserved */\nshader_type canvas_item;\nvoid fragment() {}',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/mixed-comment-styles/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/474',
      postId: 474,
      code: '// SPDX-License-Identifier: MIT\n/* Licensed under CC0 */\nshader_type canvas_item;\nvoid fragment() {}',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/form-feed-restriction-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/475',
      postId: 475,
      code: '// SPDX-License-Identifier: MIT\n\f// All rights reserved. Do not redistribute.\nshader_type canvas_item;\nvoid fragment() {}',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/vertical-tab-restriction-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/476',
      postId: 476,
      code: '// SPDX-License-Identifier: MIT\n\v// All rights reserved. Do not redistribute.\nshader_type canvas_item;\nvoid fragment() {}',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/proprietary-source-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/462',
      postId: 462,
      code: '/* Proprietary. Redistribution prohibited. */\nshader_type canvas_item;\nvoid fragment() {}',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/personal-use-source-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/463',
      postId: 463,
      code: '/* Personal use only; modification is forbidden. */\nshader_type canvas_item;\nvoid fragment() {}',
    },
    {
      pageUrl: 'https://godotshaders.com/shader/oversized-block-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/460',
      postId: 460,
      code: oversizedBlockHeader,
      truncated: true,
    },
    {
      pageUrl: 'https://godotshaders.com/shader/oversized-line-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/461',
      postId: 461,
      code: oversizedLineHeader,
      truncated: true,
    },
  ];
  const calls = [];
  const routes = new Map();
  for (const item of cases) {
    routes.set(item.pageUrl, textResponse(`<body class="postid-${item.postId}"><article id="post-${item.postId}" class="shader_license-mit"><h1>MIT page</h1><div class="shader_license_block">MIT License</div></article></body>`));
    routes.set(item.apiUrl, jsonResponse({ id: item.postId, title: 'MIT page', shader_type: 'canvas_item', code: item.code }));
  }
  const { service } = serviceWith(routeFetch(routes, calls));

  for (const item of cases) {
    const result = await service.importLink({ url: item.pageUrl, authorizationBasis: 'licensed' });
    assert.equal(result.status, 'ok');
    assert.equal(result.resource.rights.reviewRequired, true);
    assert.equal(result.resource.blobs.length, 0);
    assert.equal(result.resource.contentPolicy, 'metadata_only');
    assert.equal(result.resource.metadata.sourceFetched, true);
    assert.equal(result.resource.metadata.sourceCached, false);
    assert.equal(result.resource.metadata.sourceHeaderDeclared, true);
    assert.equal(result.resource.metadata.sourceHeaderUnrecognized, true);
    assert.equal(result.resource.metadata.sourceHeaderTruncated, Boolean(item.truncated));
    assert.deepEqual(result.resource.metadata.sourceHeaderLicense, []);
    const sourceEvidence = result.resource.rights.evidence.find((entry) => entry.kind === 'source-header-license');
    assert.ok(sourceEvidence);
    assert.ok(Buffer.byteLength(sourceEvidence.text, 'utf8') <= 512);
  }
  assert.equal(calls.length, cases.length * 2);
  assert.ok(calls.every(({ url }) => cases.some((item) => item.pageUrl === url || item.apiUrl === url)));
});

test('Godot caches only a strict SPDX declaration or the exact published Bamboo header', async () => {
  const cases = [
    {
      pageUrl: 'https://godotshaders.com/shader/copyright-mit-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/464',
      postId: 464,
      code: '/* Copyright 2026 Fixture Author. MIT License. */\nshader_type canvas_item;\nvoid fragment() {}',
      sourceHeaderLicense: [],
      cached: false,
      unrecognized: true,
    },
    {
      pageUrl: 'https://godotshaders.com/shader/author-only-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/465',
      postId: 465,
      code: '/* Original shader by Fixture Author. */\nshader_type canvas_item;\nvoid fragment() {}',
      sourceHeaderLicense: [],
      cached: false,
      unrecognized: true,
    },
    {
      pageUrl: 'https://godotshaders.com/shader/no-source-header/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/467',
      postId: 467,
      code: 'shader_type canvas_item;\nvoid fragment() {}',
      sourceHeaderLicense: [],
      cached: false,
      unrecognized: false,
    },
    {
      pageUrl: 'https://godotshaders.com/shader/procedural-bamboo/',
      apiUrl: 'https://godotshaders.com/wp-json/shader_data/shader/475',
      postId: 475,
      code: '// 竹シェーダー by あるる（きのもと 結衣） @arlez80\n// Bamboo Shader by Yui Kinomoto\n\n// MIT License\nshader_type spatial;\nvoid fragment() {}',
      sourceHeaderLicense: ['MIT'],
      cached: true,
      unrecognized: false,
      shaderType: 'spatial',
      pageClassOnly: true,
    },
  ];
  const calls = [];
  const routes = new Map();
  for (const item of cases) {
    const licenseBlock = item.pageClassOnly ? '' : '<div class="shader_license_block">MIT License</div>';
    routes.set(item.pageUrl, textResponse(`<body class="postid-${item.postId}"><article id="post-${item.postId}" class="shader_license-mit"><h1>MIT page</h1>${licenseBlock}</article></body>`));
    routes.set(item.apiUrl, jsonResponse({ id: item.postId, title: 'MIT page', shader_type: item.shaderType || 'canvas_item', code: item.code }));
  }
  const { service } = serviceWith(routeFetch(routes, calls));

  for (const item of cases) {
    const result = await service.importLink({ url: item.pageUrl, authorizationBasis: 'licensed' });
    assert.equal(result.status, 'ok');
    assert.equal(result.resource.rights.spdx, item.cached ? 'MIT' : null);
    assert.equal(result.resource.rights.reviewRequired, !item.cached);
    assert.equal(result.resource.contentPolicy, item.cached ? 'full_source' : 'metadata_only');
    assert.equal(result.resource.blobs.length, item.cached ? 1 : 0);
    assert.equal(result.resource.metadata.cacheAllowedByLicense, item.cached);
    assert.equal(result.resource.metadata.sourceCached, item.cached);
    assert.equal(result.resource.metadata.sourceHeaderUnrecognized, item.unrecognized);
    assert.deepEqual(result.resource.metadata.sourceHeaderLicense, item.sourceHeaderLicense);
  }
  assert.equal(calls.length, cases.length * 2);
});
