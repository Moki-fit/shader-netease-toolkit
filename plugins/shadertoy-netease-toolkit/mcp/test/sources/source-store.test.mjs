import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ProviderSyncLeaseError, SOURCE_STORE_SCHEMA_VERSION, SourceStore } from '../../src/sources/source-store.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function makeResource(overrides = {}) {
  const ref = overrides.ref ?? { provider: 'isf', id: 'basic-color' };
  return {
    ref,
    kind: 'shader',
    title: 'Basic color study',
    author: 'shader-author',
    description: 'A procedural color study for provider-neutral search.',
    tags: ['color', 'procedural'],
    language: 'GLSL',
    canonicalUrl: `https://example.invalid/${ref.provider}/${ref.id}`,
    rights: { spdx: 'MIT', source: 'declared' },
    provenance: { retrievedFrom: 'official-api' },
    authorization: { mode: 'author-declared' },
    contentPolicy: { mode: 'stored_content' },
    metadata: { version: 1 },
    blobs: [{ role: 'fragment', mimeType: 'text/plain', body: 'void main() {}' }],
    ...overrides,
  };
}

function withStore(work) {
  const store = new SourceStore(':memory:');
  try {
    return work(store);
  } finally {
    store.close();
  }
}

function withSharedDatabase(work) {
  const directory = mkdtempSync(join(tmpdir(), 'shadertoy-netease-source-store-'));
  try {
    return work(join(directory, 'resources.sqlite3'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('current schema isolates resources by composite provider/id and returns stored blobs only from get', () => {
  withStore((store) => {
    assert.equal(store.status().schemaVersion, SOURCE_STORE_SCHEMA_VERSION);
    store.upsertResource(makeResource({ ref: { provider: 'isf', id: 'shared-id' }, title: 'ISF resource' }));
    store.upsertResource(makeResource({ ref: { provider: 'twigl', id: 'shared-id' }, title: 'twigl resource' }));

    assert.equal(store.status().counts.resources, 2);
    assert.equal(store.getResource({ provider: 'isf', id: 'shared-id' }).title, 'ISF resource');
    assert.equal(store.getResource({ provider: 'twigl', id: 'shared-id' }).title, 'twigl resource');

    const summary = store.search('resource');
    assert.equal(summary.length, 2);
    assert.equal(Object.hasOwn(summary[0], 'blobs'), false);
    assert.equal(JSON.stringify(summary).includes('void main() {}'), false);
    assert.equal(summary[0].blobCount, 1);
    assert.equal(store.getResource({ provider: 'isf', id: 'shared-id' }).blobs[0].body, 'void main() {}');
  });
});

test('FTS searches title, description, and tags without returning stored bodies', () => {
  withStore((store) => {
    store.upsertResource(makeResource({
      title: 'Hexagonal aurora',
      description: 'An animated borealis effect.',
      tags: ['hex-grid', 'night'],
      blobs: [{ role: 'fragment', mimeType: 'text/plain', body: 'secret source body' }],
    }));
    assert.equal(store.search('aurora').length, 1);
    assert.equal(store.search('borealis').length, 1);
    assert.equal(store.search('hex-grid').length, 1);
    assert.equal(Object.hasOwn(store.search('aurora')[0], 'blobs'), false);
  });
});

test('only full_text knowledge blobs enter FTS; shader and non-full-text source bodies stay private', () => {
  withStore((store) => {
    store.upsertResource(makeResource({
      ref: { provider: 'webgl-fundamentals', id: 'lesson-unique' },
      kind: 'knowledge',
      title: 'Texture lesson',
      description: 'A WebGL learning link.',
      contentPolicy: 'full_text',
      blobs: [{ role: 'lesson', mimeType: 'text/markdown', body: 'The lesson explains nebularis-unique-token.' }],
    }));
    store.upsertResource(makeResource({
      ref: { provider: 'isf', id: 'shader-private' },
      kind: 'shader',
      title: 'Shader listing',
      description: 'A shader metadata record.',
      contentPolicy: 'full_text',
      blobs: [{ role: 'fragment', mimeType: 'text/plain', body: 'shader-only-unique-token' }],
    }));
    store.upsertResource(makeResource({
      ref: { provider: 'twigl', id: 'authorized-private' },
      kind: 'shader',
      title: 'User source listing',
      description: 'A user-authorized source record.',
      contentPolicy: 'user_authorized_source',
      blobs: [{ role: 'fragment', mimeType: 'text/plain', body: 'authorized-only-unique-token' }],
    }));
    store.upsertResource(makeResource({
      ref: { provider: 'the-book-of-shaders', id: 'chapter-link' },
      kind: 'knowledge',
      title: 'Chapter link',
      description: 'A link-only book chapter.',
      contentPolicy: 'link_only',
      blobs: [],
    }));

    assert.deepEqual(
      store.search('nebularis-unique-token').map((entry) => entry.ref),
      [{ provider: 'webgl-fundamentals', id: 'lesson-unique' }],
    );
    assert.equal(store.search('shader-only-unique-token').length, 0);
    assert.equal(store.search('authorized-only-unique-token').length, 0);
    assert.equal(store.search('book-body-never-stored-token').length, 0);
  });
});

test('link_only resources preserve zero content bytes and reject blobs', () => {
  withStore((store) => {
    const linkOnly = makeResource({
      ref: { provider: 'webgl-fundamentals', id: 'textures' },
      kind: 'knowledge',
      contentPolicy: 'link_only',
      blobs: [],
    });
    const result = store.upsertResource(linkOnly);
    assert.equal(result.bodyBytes, 0);
    const stored = store.getResource(linkOnly.ref);
    assert.equal(stored.bodyBytes, 0);
    assert.deepEqual(stored.blobs, []);

    assert.throws(
      () => store.upsertResource(makeResource({ contentPolicy: 'link_only' })),
      /link_only resources cannot store blobs/i,
    );
  });
});

test('missing rights remain review_required with no implicit SPDX default', () => {
  withStore((store) => {
    const ref = { provider: 'godot-shaders', id: 'unknown-license' };
    const result = store.upsertResource(makeResource({ ref, rights: undefined }));
    assert.equal(result.licenseSpdx, null);
    assert.equal(result.reviewRequired, true);
    const stored = store.getResource(ref);
    assert.equal(stored.rights, null);
    assert.equal(stored.licenseSpdx, null);
    assert.equal(stored.reviewRequired, true);
  });
});

test('oversized blobs are rejected before any resource row is written', () => {
  withStore((store) => {
    const ref = { provider: 'isf', id: 'too-large' };
    const oversized = 'x'.repeat(MAX_BODY_BYTES + 1);
    assert.throws(
      () => store.upsertResource(makeResource({ ref, blobs: [{ role: 'fragment', mimeType: 'text/plain', body: oversized }] })),
      /body limit/i,
    );
    assert.equal(store.getResource(ref), null);
    assert.equal(store.status().counts.resources, 0);
  });
});

test('write transactions roll back resource metadata, FTS rows, and blobs together', () => {
  withStore((store) => {
    const ref = { provider: 'isf', id: 'atomic' };
    store.upsertResource(makeResource({ ref, title: 'Before update', blobs: [{ role: 'fragment', mimeType: 'text/plain', body: 'before' }] }));
    store.db.exec(`
      CREATE TRIGGER force_blob_failure
      BEFORE INSERT ON resource_blobs
      WHEN NEW.role = 'explode'
      BEGIN
        SELECT RAISE(ABORT, 'forced blob write failure');
      END;
    `);

    assert.throws(
      () => store.upsertResource(makeResource({
        ref,
        title: 'After update',
        blobs: [
          { role: 'fragment', mimeType: 'text/plain', body: 'after' },
          { role: 'explode', mimeType: 'text/plain', body: 'never commits' },
        ],
      })),
      /forced blob write failure/i,
    );

    const stored = store.getResource(ref);
    assert.equal(stored.title, 'Before update');
    assert.equal(stored.blobs[0].body, 'before');
    assert.equal(store.search('Before update').length, 1);
    assert.equal(store.search('After update').length, 0);
  });
});

test('provider sync state preserves revision, cursor, status, and updatedAt JSON', () => {
  withStore((store) => {
    assert.equal(store.getSyncState('isf'), null);
    const written = store.setSyncState('isf', {
      revision: 'commit-123',
      cursor: 'page-2',
      status: 'partial',
      updatedAt: '2026-09-04T00:00:00.000Z',
      extra: { imported: 10 },
    });
    assert.deepEqual(written, {
      provider: 'isf',
      revision: 'commit-123',
      cursor: 'page-2',
      status: 'partial',
      updatedAt: '2026-09-04T00:00:00.000Z',
      extra: { imported: 10 },
    });
    assert.deepEqual(store.getSyncState('isf'), written);
    assert.equal(store.status().counts.providerSyncStates, 1);
  });
});

test('complete provider sync atomically prunes an absent resource only after completion', () => {
  withStore((store) => {
    const retiredRef = { provider: 'isf', id: 'ISF/Retired.fs' };
    const currentRef = { provider: 'isf', id: 'ISF/Current.fs' };
    const unrelatedRef = { provider: 'twigl', id: 'keep-me' };
    store.upsertResource(makeResource({ ref: retiredRef, title: 'Retired revision shader' }));
    store.upsertResource(makeResource({ ref: currentRef, title: 'Current revision shader' }));
    store.upsertResource(makeResource({ ref: unrelatedRef, title: 'Unrelated provider shader' }));
    store.setSyncState('isf', {
      revision: 'old-revision',
      cursor: '1',
      total: 1,
      status: 'complete',
      updatedAt: '2026-09-04T00:00:00.000Z',
    });
    const claimed = store.claimProviderSyncRun('isf');
    assert.equal(claimed.acquired, true);
    const runToken = claimed.runToken;

    assert.throws(
      () => store.completeProviderSync('isf', runToken, {
        revision: 'new-revision',
        cursor: '0',
        total: 0,
        status: 'partial',
        updatedAt: '2026-09-04T00:01:00.000Z',
      }, [currentRef.id]),
      /requires a complete sync state/i,
    );
    assert.ok(store.getResource(retiredRef), 'a partial revision must not remove prior resources');

    assert.throws(
      () => store.completeProviderSync('isf', runToken, {
        revision: 'new-revision',
        cursor: '0',
        total: 0,
        status: 'complete',
        updatedAt: '2026-09-04T00:01:00.000Z',
      }, []),
      /at least one eligible resource id/i,
    );
    assert.ok(store.getResource(retiredRef), 'an empty eligible list must never clear a provider cache');
    assert.equal(store.status().counts.providerSyncLeases, 1, 'a rejected empty list does not consume the active run token');

    store.db.exec(`
      CREATE TRIGGER force_reconciliation_failure
      BEFORE DELETE ON resources
      WHEN OLD.provider = 'isf'
      BEGIN
        SELECT RAISE(ABORT, 'forced reconciliation failure');
      END;
    `);
    assert.throws(
      () => store.completeProviderSync('isf', runToken, {
        revision: 'new-revision',
        cursor: '0',
        total: 0,
        status: 'complete',
        updatedAt: '2026-09-04T00:01:00.000Z',
      }, [currentRef.id]),
      /forced reconciliation failure/i,
    );
    assert.ok(store.getResource(retiredRef), 'a failed transaction restores resources');
    assert.equal(store.search('Retired').length, 1, 'a failed transaction restores FTS rows');
    assert.equal(store.getSyncState('isf').revision, 'old-revision', 'a failed transaction restores sync state');
    store.db.exec('DROP TRIGGER force_reconciliation_failure');

    const completed = store.completeProviderSync('isf', runToken, {
      revision: 'new-revision',
      cursor: '0',
      total: 0,
      status: 'complete',
      updatedAt: '2026-09-04T00:01:00.000Z',
    }, [currentRef.id]);
    assert.equal(completed.removedResources, 1);
    assert.equal(store.getResource(retiredRef), null);
    assert.equal(store.search('Retired').length, 0, 'a removed completed revision is no longer searchable');
    assert.ok(store.getResource(currentRef));
    assert.ok(store.getResource(unrelatedRef), 'reconciliation is limited to the completed provider');
    assert.equal(store.getSyncState('isf').revision, 'new-revision');
    assert.equal(store.getSyncState('isf').status, 'complete');
    assert.equal(store.status().counts.providerSyncLeases, 0, 'complete releases its lease in the same transaction');
  });
});

test('provider sync leases are provider-scoped, recover after expiry, and reject stale cross-connection writes', () => {
  withSharedDatabase((databasePath) => {
    let clockMs = 1_000_000;
    const options = {
      path: databasePath,
      providerSyncLeaseMs: 1_000,
      syncClock: () => clockMs,
    };
    const first = new SourceStore(options);
    const second = new SourceStore(options);
    try {
      const firstIsf = first.claimProviderSyncRun('isf');
      assert.equal(firstIsf.acquired, true);
      assert.equal(second.claimProviderSyncRun('isf').acquired, false, 'one provider has one active run across connections');
      const secondWebgl = second.claimProviderSyncRun('webgl-fundamentals');
      assert.equal(secondWebgl.acquired, true, 'different providers remain independent');

      clockMs += 1_000;
      const secondIsf = second.claimProviderSyncRun('isf');
      assert.equal(secondIsf.acquired, true, 'an exactly expired lease is recoverable');
      const currentRef = { provider: 'isf', id: 'ISF/Current.fs' };
      second.upsertResourceForProviderSync(
        'isf',
        secondIsf.runToken,
        'revision-b',
        makeResource({ ref: currentRef, title: 'Current revision shader' }),
      );
      second.setSyncStateForProviderSync('isf', secondIsf.runToken, {
        revision: 'revision-b',
        cursor: '1',
        total: 1,
        status: 'partial',
        updatedAt: '2026-09-04T00:00:00.000Z',
      });
      second.completeProviderSync('isf', secondIsf.runToken, {
        revision: 'revision-b',
        cursor: '1',
        total: 1,
        status: 'complete',
        updatedAt: '2026-09-04T00:00:01.000Z',
      }, [currentRef.id]);

      assert.throws(
        () => first.upsertResourceForProviderSync(
          'isf',
          firstIsf.runToken,
          'revision-a',
          makeResource({ ref: { provider: 'isf', id: 'ISF/Stale.fs' } }),
        ),
        ProviderSyncLeaseError,
      );
      assert.throws(
        () => first.setSyncStateForProviderSync('isf', firstIsf.runToken, {
          revision: 'revision-a', cursor: '1', total: 1, status: 'partial', updatedAt: '2026-09-04T00:00:02.000Z',
        }),
        ProviderSyncLeaseError,
      );
      assert.throws(
        () => first.completeProviderSync('isf', firstIsf.runToken, {
          revision: 'revision-a', cursor: '0', total: 0, status: 'complete', updatedAt: '2026-09-04T00:00:03.000Z',
        }, [currentRef.id]),
        ProviderSyncLeaseError,
      );
      assert.equal(first.releaseProviderSyncRun('isf', firstIsf.runToken), false, 'a stale release cannot remove a newer run');
      assert.ok(first.getResource(currentRef));
      assert.equal(first.getResource({ provider: 'isf', id: 'ISF/Stale.fs' }), null);
      assert.equal(first.getSyncState('isf').revision, 'revision-b');
      assert.equal(first.getSyncState('isf').status, 'complete');
      assert.equal(second.releaseProviderSyncRun('webgl-fundamentals', secondWebgl.runToken), true);
    } finally {
      first.close();
      second.close();
    }
  });
});

test('search filtering and pagination have stable title/provider/id ordering', () => {
  withStore((store) => {
    store.upsertResource(makeResource({ ref: { provider: 'isf', id: '2' }, title: 'Alpha', kind: 'shader' }));
    store.upsertResource(makeResource({ ref: { provider: 'twigl', id: '1' }, title: 'Alpha', kind: 'shader' }));
    store.upsertResource(makeResource({ ref: { provider: 'isf', id: '1' }, title: 'Alpha', kind: 'shader' }));
    store.upsertResource(makeResource({
      ref: { provider: 'isf', id: 'knowledge' },
      title: 'Beta',
      kind: 'knowledge',
      contentPolicy: 'link_only',
      blobs: [],
    }));

    const all = store.search('', { limit: 10 });
    assert.deepEqual(all.map((entry) => `${entry.ref.provider}/${entry.ref.id}`), [
      'isf/1',
      'isf/2',
      'twigl/1',
      'isf/knowledge',
    ]);
    assert.deepEqual(store.search('', { limit: 2, offset: 1 }).map((entry) => `${entry.ref.provider}/${entry.ref.id}`), [
      'isf/2',
      'twigl/1',
    ]);
    assert.deepEqual(store.search('', { provider: 'isf', kind: 'shader', limit: 10 }).map((entry) => entry.ref.id), ['1', '2']);
    assert.deepEqual(store.search('', { kind: 'knowledge', limit: 10 }).map((entry) => entry.ref.id), ['knowledge']);
  });
});
