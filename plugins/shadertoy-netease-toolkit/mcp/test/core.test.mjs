import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_SOURCE_BYTES, analyzeProject, analyzeSource } from '../src/analyzer.mjs';
import { LibraryStore } from '../src/db.mjs';
import { detectLicense } from '../src/license.mjs';

function makeProject(overrides = {}) {
  return {
    id: 'XslGz8',
    title: 'Ocean feedback study',
    author: 'shader-author',
    description: 'A multipass water shader suitable for local analysis.',
    tags: ['water', 'feedback'],
    source: {
      provider: 'shadertoy',
      url: 'https://www.shadertoy.com/view/XslGz8',
    },
    rawPayload: {
      Shader: {
        info: { id: 'XslGz8' },
      },
    },
    renderpasses: [
      {
        index: 0,
        name: 'Buffer A',
        type: 'buffer',
        description: 'history buffer',
        code: `
          uniform sampler2D iChannel0;
          void mainImage(out vec4 color, in vec2 fragCoord) {
            color = texture(iChannel0, fragCoord / iResolution.xy);
          }
        `,
        inputs: [{ channel: 0, ctype: 'buffer', id: 'buffer-a-output' }],
        outputs: [{ channel: 0, id: 'buffer-a-output' }],
      },
      {
        index: 1,
        name: 'Image',
        type: 'image',
        code: 'void mainImage(out vec4 color, in vec2 fragCoord) { color = vec4(1.0); }',
        inputs: [{ channel: 0, ctype: 'buffer', id: 'buffer-a-output' }],
        outputs: [],
      },
    ],
    ...overrides,
  };
}

test('schema v1 migrates, persists a canonical project, and searches it through FTS', () => {
  const store = new LibraryStore(':memory:');
  try {
    assert.equal(store.status().schemaVersion, 1);
    const write = store.upsertProject(makeProject());
    assert.equal(write.created, true);
    assert.equal(write.analysis.graph.hasFeedback, true);

    const found = store.search('ocean feedback');
    assert.equal(found.length, 1);
    assert.equal(found[0].id, 'XslGz8');

    const project = store.getProject('XslGz8');
    assert.equal(project.title, 'Ocean feedback study');
    assert.equal(project.renderpasses.length, 2);
    assert.equal(project.passes, project.renderpasses);
    assert.equal(project.renderpasses[0].inputs[0].id, 'buffer-a-output');
    assert.equal(project.analysis.compiled, false);
    assert.equal(project.passGraph.hasFeedback, true);
    assert.deepEqual(project.rawPayload, makeProject().rawPayload);
    assert.equal(project.license.spdx, 'CC-BY-NC-SA-3.0');
  } finally {
    store.close();
  }
});

test('license detection provides default and declared MIT classifications with evidence', () => {
  const defaultLicense = detectLicense();
  assert.equal(defaultLicense.spdx, 'CC-BY-NC-SA-3.0');
  assert.equal(defaultLicense.commercial, 'restricted');
  assert.equal(defaultLicense.adaptation, 'allowed-with-share-alike');
  assert.equal(defaultLicense.evidence[0].kind, 'default-policy');
  assert.match(defaultLicense.disclaimer, /not legal advice/i);

  const mit = detectLicense('Released under the MIT License.');
  assert.equal(mit.spdx, 'MIT');
  assert.equal(mit.commercial, 'allowed');
  assert.equal(mit.adaptation, 'allowed');
  assert.equal(mit.evidence[0].kind, 'declared-license');
});

test('license classification preserves versions and requires review for composite or unrecognised declarations', () => {
  assert.equal(detectLicense('CC-BY-NC-SA-4.0').spdx, 'CC-BY-NC-SA-4.0');
  assert.equal(detectLicense('CC BY-NC-SA 3.0').spdx, 'CC-BY-NC-SA-3.0');
  assert.equal(detectLicense('GPL-2.0-only').spdx, 'GPL-2.0-only');
  assert.equal(detectLicense('GPL-3.0-or-later').spdx, 'GPL-3.0-or-later');

  const composite = detectLicense('MIT OR Apache-2.0');
  assert.equal(composite.review, true);
  assert.equal(composite.status, 'review');
  assert.notEqual(composite.spdx, 'MIT');
  assert.deepEqual(composite.conflicts, ['MIT', 'Apache-2.0']);

  const mpl = detectLicense('MPL-2.0');
  assert.equal(mpl.review, true);
  assert.equal(mpl.commercial, 'unknown');
  assert.notEqual(mpl.spdx, 'CC-BY-NC-SA-3.0');
});

test('an SPDX declaration in a leading pass comment is used only after explicit metadata', () => {
  const store = new LibraryStore(':memory:');
  try {
    const headerProject = makeProject({ id: 'MslGWN' });
    headerProject.renderpasses[0].code = `// SPDX-License-Identifier: MIT
void mainImage(out vec4 color, in vec2 fragCoord) { color = vec4(1.0); }`;
    const headerWrite = store.upsertProject(headerProject);
    assert.equal(headerWrite.license.spdx, 'MIT');
    assert.equal(headerWrite.license.source, 'source-header');
    assert.equal(store.getProject('MslGWN').license.spdx, 'MIT');

    const metadataProject = makeProject({ id: '4dXGR8', license: 'Apache-2.0' });
    metadataProject.renderpasses[0].code = `// SPDX-License-Identifier: MIT
void mainImage(out vec4 color, in vec2 fragCoord) { color = vec4(1.0); }`;
    assert.equal(store.upsertProject(metadataProject).license.spdx, 'Apache-2.0');

    const bodyMention = makeProject({ id: 'lXslGz' });
    bodyMention.renderpasses[0].code = `void mainImage(out vec4 color, in vec2 fragCoord) {
  // SPDX-License-Identifier: MIT
  color = vec4(1.0);
}`;
    assert.equal(store.upsertProject(bodyMention).license.spdx, 'CC-BY-NC-SA-3.0');
  } finally {
    store.close();
  }
});

test('multiple pass declarations remain a reviewable conflict unless metadata resolves priority', () => {
  const store = new LibraryStore(':memory:');
  try {
    const conflict = makeProject({ id: '4dXGR8' });
    conflict.renderpasses[0].code = `// SPDX-License-Identifier: MIT
void mainImage(out vec4 color, in vec2 fragCoord) { color = vec4(1.0); }`;
    conflict.renderpasses[1].code = `// SPDX-License-Identifier: Apache-2.0
void mainImage(out vec4 color, in vec2 fragCoord) { color = vec4(1.0); }`;
    const conflictWrite = store.upsertProject(conflict);
    assert.equal(conflictWrite.license.review, true);
    assert.equal(conflictWrite.license.spdx, 'LicenseRef-Conflict');
    assert.deepEqual(conflictWrite.license.conflicts, ['MIT', 'Apache-2.0']);
    assert.deepEqual(conflictWrite.license.evidence.map((entry) => entry.passIndex), [0, 1]);

    const metadata = makeProject({ id: 'lXslGz', license: 'BSD-2-Clause' });
    metadata.renderpasses = conflict.renderpasses;
    const resolved = store.upsertProject(metadata).license;
    assert.equal(resolved.spdx, 'BSD-2-Clause');
    assert.equal(resolved.review, false);
  } finally {
    store.close();
  }
});

test('project analysis identifies buffer feedback without claiming compilation', () => {
  const result = analyzeProject(makeProject());
  assert.equal(result.status, 'analyzed');
  assert.equal(result.graph.hasFeedback, true);
  assert.equal(result.feedback, true);
  assert.equal(result.graph.feedbackEdges.length, 1);
  assert.equal(result.compiled, false);
  assert.match(result.disclaimer, /did not compile/i);
});

test('numeric and string pass output IDs resolve the same feedback edge', () => {
  const result = analyzeProject({
    id: 'MslGWN',
    renderpasses: [{
      index: 0,
      name: 'Buffer A',
      type: 'buffer',
      code: 'void mainImage(out vec4 color, in vec2 fragCoord) { color = vec4(1.0); }',
      inputs: [{ channel: 0, ctype: 'buffer', id: 42 }],
      outputs: [{ channel: 0, id: '42' }],
    }],
  });
  assert.equal(result.graph.hasFeedback, true);
  assert.deepEqual(result.graph.feedbackEdges, [{ from: 'pass:0', to: 'pass:0', channel: 0, kind: 'buffer' }]);
});

test('zero-pass projects are incomplete and never low-cost candidates', () => {
  const result = analyzeProject({ id: 'MslGWN', renderpasses: [] });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.costLevel, 'unknown');
  assert.equal(result.cost.score, null);
  assert.ok(result.findings.some((finding) => finding.code === 'no_renderpasses'));
});

test('line lookup remains precomputed and constant-work for repeated legal-size matches', () => {
  const prefix = 'void main(){float x=0.0;';
  const repeatedStatement = 'x += 1.0 / 2.0;';
  const suffix = '}';
  const repeats = Math.floor((MAX_SOURCE_BYTES - prefix.length - suffix.length) / repeatedStatement.length);
  const source = `${prefix}${repeatedStatement.repeat(repeats)}${suffix}`;
  assert.ok(Buffer.byteLength(source, 'utf8') <= MAX_SOURCE_BYTES);

  const result = analyzeSource(source);
  assert.equal(result.status, 'analyzed');
  assert.equal(result.scan.lineIndex, 'offset-table');
  assert.equal(result.scan.lineIndexBuildSteps, source.length);
  assert.equal(result.scan.lineLookupSteps, result.scan.lineLookups);
  assert.ok(result.scan.lineLookups > 50_000);
});

test('the two MiB source limit rejects oversized source before it can be stored', () => {
  const store = new LibraryStore(':memory:');
  try {
    const oversized = makeProject({
      id: 'MslGWN',
      renderpasses: [
        {
          index: 0,
          name: 'Image',
          type: 'image',
          code: 'x'.repeat(MAX_SOURCE_BYTES + 1),
          inputs: [],
          outputs: [],
        },
      ],
    });
    assert.throws(() => store.upsertProject(oversized), /maximum/i);
    assert.equal(store.getProject('MslGWN'), null);
  } finally {
    store.close();
  }
});

test('a failed multi-table write rolls back the enclosing project transaction', () => {
  const store = new LibraryStore(':memory:');
  try {
    const invalid = makeProject({
      id: '4dXGR8',
      renderpasses: [
        { index: 0, name: 'Buffer A', type: 'buffer', code: 'void mainImage(out vec4 c, in vec2 p) {}', inputs: [], outputs: [] },
        { index: 0, name: 'Image', type: 'image', code: 'void mainImage(out vec4 c, in vec2 p) {}', inputs: [], outputs: [] },
      ],
    });
    assert.throws(() => store.upsertProject(invalid));
    assert.equal(store.getProject('4dXGR8'), null);
    assert.equal(store.status().counts.shaders, 0);
  } finally {
    store.close();
  }
});

test('catalog id lists preserve terminal markers until a later catalog run confirms the id again', () => {
  const store = new LibraryStore(':memory:');
  try {
    const firstRunId = store.beginSync('catalog');
    assert.deepEqual(store.markCatalog(['XslGz8'], firstRunId), { count: 1, runId: firstRunId });
    const pending = store.listPending({ limit: 10 });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, 'XslGz8');
    assert.deepEqual(pending[0].rawPayload, { id: 'XslGz8' });
    assert.equal(store.markFetchTerminal('XslGz8', { code: 'not_found' }).fetchStatus, 'terminal');
    assert.equal(store.countPending(), 0);
    assert.deepEqual(store.listPending(), []);

    // Replaying the same successful catalog run is idempotent: it does not
    // turn an already-terminal detail fetch into an unbounded resume retry.
    store.markCatalog(['XslGz8', 'XslGz8'], firstRunId);
    assert.equal(store.countPending(), 0);
    assert.equal(
      store.db.prepare('SELECT catalog_count FROM sync_runs WHERE id = ?').get(firstRunId).catalog_count,
      1,
    );

    const recoveryRunId = store.beginSync('catalog');
    assert.deepEqual(store.markCatalog(['XslGz8'], recoveryRunId), { count: 1, runId: recoveryRunId });
    assert.equal(store.countPending(), 1);
    assert.deepEqual(store.listPending(), [{
      id: 'XslGz8',
      title: '',
      author: '',
      updatedAt: null,
      rawPayload: { id: 'XslGz8' },
      fetchAttempts: 0,
      fetchError: null,
    }]);

    // Duplicate markCatalog calls in the recovery run retain one queue row
    // and its clean requeued state rather than duplicating or mutating it.
    store.markCatalog(['XslGz8', 'XslGz8'], recoveryRunId);
    assert.equal(store.status().counts.catalog, 1);
    assert.equal(store.countPending(), 1);
    assert.equal(
      store.db.prepare('SELECT catalog_count FROM sync_runs WHERE id = ?').get(recoveryRunId).catalog_count,
      1,
    );
  } finally {
    store.close();
  }
});
