import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

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

function legacyImplicitDefaultLicense(overrides = {}) {
  return {
    spdx: 'CC-BY-NC-SA-3.0',
    identifier: 'CC-BY-NC-SA-3.0',
    name: 'Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported',
    source: 'default',
    evidence: [{ kind: 'default-policy', text: 'Legacy Shadertoy default', match: 'Shadertoy default' }],
    commercial: 'restricted',
    adaptation: 'allowed-with-share-alike',
    attribution: 'required',
    shareAlike: true,
    review: false,
    status: 'default',
    ...overrides,
  };
}

function explicitMitLicense() {
  return {
    spdx: 'MIT',
    identifier: 'MIT',
    name: 'MIT License',
    source: 'metadata',
    evidence: [{ kind: 'declared-license', text: 'MIT', match: 'MIT' }],
    commercial: 'allowed',
    adaptation: 'allowed',
    attribution: 'required',
    shareAlike: false,
    review: false,
    review_required: false,
    status: 'classified',
  };
}

function interleavedExplicitReplacement(shaderId, title, code) {
  return {
    title,
    code,
    license: explicitMitLicense(),
    rawPayload: {
      Shader: {
        info: { id: shaderId, license: 'MIT', name: title },
        generation: 'new',
      },
    },
  };
}

function sqliteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqliteBlobLiteral(value) {
  return `X'${Buffer.from(value).toString('hex')}'`;
}

function installLicenseCasInterleaveTrigger(store, name, shaderId, replacement) {
  const rawPayload = gzipSync(Buffer.from(JSON.stringify(replacement.rawPayload), 'utf8'));
  store.db.exec(`
    PRAGMA recursive_triggers = OFF;
    CREATE TRIGGER ${name}
    BEFORE UPDATE OF license_spdx, license_json ON shaders
    WHEN OLD.shader_id = ${sqliteLiteral(shaderId)}
      AND OLD.license_spdx = 'CC-BY-NC-SA-3.0'
      AND NEW.license_spdx = 'LicenseRef-Unknown'
    BEGIN
      UPDATE shaders
      SET title = ${sqliteLiteral(replacement.title)},
          raw_json_gzip = ${sqliteBlobLiteral(rawPayload)},
          license_spdx = ${sqliteLiteral(replacement.license.spdx)},
          license_json = ${sqliteLiteral(JSON.stringify(replacement.license))}
      WHERE shader_id = OLD.shader_id;
      UPDATE passes
      SET code = ${sqliteLiteral(replacement.code)},
          code_bytes = ${Buffer.byteLength(replacement.code, 'utf8')}
      WHERE shader_id = OLD.shader_id AND pass_index = 0;
      SELECT RAISE(IGNORE);
    END;
  `);
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
    assert.equal(project.license.spdx, 'LicenseRef-Unknown');
    assert.equal(project.license.commercial, 'unknown');
    assert.equal(project.license.adaptation, 'unknown');
    assert.equal(project.license.review_required, true);
  } finally {
    store.close();
  }
});

test('license detection keeps missing declarations conservative and preserves declared MIT evidence', () => {
  const defaultLicense = detectLicense();
  assert.equal(defaultLicense.spdx, 'LicenseRef-Unknown');
  assert.equal(defaultLicense.commercial, 'unknown');
  assert.equal(defaultLicense.adaptation, 'unknown');
  assert.equal(defaultLicense.review, true);
  assert.equal(defaultLicense.review_required, true);
  assert.equal(defaultLicense.status, 'review_required');
  assert.equal(defaultLicense.evidence[0].kind, 'missing-license-declaration');
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
    const bodyLicense = store.upsertProject(bodyMention).license;
    assert.equal(bodyLicense.spdx, 'LicenseRef-Unknown');
    assert.equal(bodyLicense.review_required, true);
  } finally {
    store.close();
  }
});

test('legacy implicit-default rows are reclassified during migration, search, and read without changing explicit evidence', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'shadertoy-netease-license-'));
  const databasePath = path.join(directory, 'library.sqlite3');
  let store = null;
  try {
    store = new LibraryStore(databasePath);

    const missing = makeProject({ id: 'XslGz8', title: 'legacy search default' });
    const equivalent = makeProject({ id: 'MslGWN' });
    const metadata = makeProject({
      id: '4dXGR8',
      rawPayload: { Shader: { info: { id: '4dXGR8', license: 'MIT' } } },
    });
    const header = makeProject({ id: 'lXslGz' });
    header.renderpasses[0].code = `// SPDX-License-Identifier: Apache-2.0
void mainImage(out vec4 color, in vec2 fragCoord) { color = vec4(1.0); }`;

    for (const project of [missing, equivalent, metadata, header]) {
      store.upsertProject(project);
    }

    let replaceLicense = store.db.prepare('UPDATE shaders SET license_spdx = ?, license_json = ? WHERE shader_id = ?');
    replaceLicense.run('CC-BY-NC-SA-3.0', JSON.stringify(legacyImplicitDefaultLicense()), 'XslGz8');
    replaceLicense.run('CC-BY-NC-SA-3.0', JSON.stringify(legacyImplicitDefaultLicense({ source: undefined, status: undefined, evidence: [] })), 'MslGWN');
    replaceLicense.run('CC-BY-NC-SA-3.0', JSON.stringify(legacyImplicitDefaultLicense()), '4dXGR8');
    replaceLicense.run('CC-BY-NC-SA-3.0', JSON.stringify(legacyImplicitDefaultLicense()), 'lXslGz');
    store.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('1', 'license_policy_version');
    store.close();
    store = new LibraryStore(databasePath);
    replaceLicense = store.db.prepare('UPDATE shaders SET license_spdx = ?, license_json = ? WHERE shader_id = ?');
    assert.equal(store.db.prepare('SELECT value FROM meta WHERE key = ?').get('license_policy_version').value, '2');

    const storedAfterMigration = (id) => JSON.parse(
      store.db.prepare('SELECT license_json FROM shaders WHERE shader_id = ?').get(id).license_json,
    );
    assert.equal(storedAfterMigration('XslGz8').spdx, 'LicenseRef-Unknown');
    assert.equal(storedAfterMigration('MslGWN').status, 'review_required');
    assert.equal(storedAfterMigration('4dXGR8').spdx, 'MIT');
    assert.equal(storedAfterMigration('lXslGz').spdx, 'Apache-2.0');

    const missingLicense = store.getProject('XslGz8').license;
    assert.equal(missingLicense.spdx, 'LicenseRef-Unknown');
    assert.equal(missingLicense.review_required, true);
    assert.equal(missingLicense.adaptation, 'unknown');

    const equivalentLicense = store.getProject('MslGWN').license;
    assert.equal(equivalentLicense.spdx, 'LicenseRef-Unknown');
    assert.equal(equivalentLicense.review_required, true);

    const metadataLicense = store.getProject('4dXGR8').license;
    assert.equal(metadataLicense.spdx, 'MIT');
    assert.equal(metadataLicense.review_required, false);
    assert.equal(metadataLicense.source, 'metadata');

    const headerLicense = store.getProject('lXslGz').license;
    assert.equal(headerLicense.spdx, 'Apache-2.0');
    assert.equal(headerLicense.review_required, false);
    assert.equal(headerLicense.source, 'source-header');

    // A database can be copied from an old process after its migration marker
    // was written. Search must reconcile stale rows before exposing its compact
    // SPDX result, without changing the selected page or its sort order.
    replaceLicense.run('CC-BY-NC-SA-3.0', JSON.stringify(legacyImplicitDefaultLicense()), 'XslGz8');
    const searchFallback = store.search('legacy search default', { limit: 1, offset: 0 });
    assert.equal(searchFallback.length, 1);
    assert.equal(searchFallback[0].id, 'XslGz8');
    assert.equal(searchFallback[0].licenseSpdx, 'LicenseRef-Unknown');
    const afterSearch = JSON.parse(store.db.prepare('SELECT license_json FROM shaders WHERE shader_id = ?').get('XslGz8').license_json);
    assert.equal(afterSearch.status, 'review_required');

    // getProject shares the same reconciliation path if a stale row appears
    // after a search has already completed.
    replaceLicense.run('CC-BY-NC-SA-3.0', JSON.stringify(legacyImplicitDefaultLicense()), 'XslGz8');
    const readFallback = store.getProject('XslGz8').license;
    assert.equal(readFallback.spdx, 'LicenseRef-Unknown');
    assert.equal(readFallback.review_required, true);
    const persisted = JSON.parse(store.db.prepare('SELECT license_json FROM shaders WHERE shader_id = ?').get('XslGz8').license_json);
    assert.equal(persisted.status, 'review_required');
    assert.equal(persisted.spdx, 'LicenseRef-Unknown');
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('getProject keeps its old content snapshot paired with conservative licensing after an interleaved write', () => {
  const store = new LibraryStore(':memory:');
  try {
    const id = 'XslGz8';
    const oldTitle = 'CAS read old target';
    const oldCode = 'void mainImage(out vec4 color, in vec2 fragCoord) { color = vec4(0.25); }';
    const newTitle = 'CAS read new target';
    const newCode = 'void mainImage(out vec4 color, in vec2 fragCoord) { color = vec4(0.75); }';
    const project = makeProject({
      id,
      title: oldTitle,
      rawPayload: { Shader: { info: { id }, generation: 'old' } },
    });
    project.renderpasses[0].code = oldCode;
    const replacement = interleavedExplicitReplacement(id, newTitle, newCode);
    store.upsertProject(project);
    store.db
      .prepare('UPDATE shaders SET license_spdx = ?, license_json = ? WHERE shader_id = ?')
      .run('CC-BY-NC-SA-3.0', JSON.stringify(legacyImplicitDefaultLicense()), id);
    // The trigger simulates a second SQLite writer winning between the lazy
    // reconciliation snapshot and its CAS update.
    installLicenseCasInterleaveTrigger(store, 'interleave_read_license_trigger', id, replacement);

    const first = store.getProject(id);
    assert.equal(first.title, oldTitle);
    assert.equal(first.renderpasses[0].code, oldCode);
    assert.equal(first.rawPayload.Shader.generation, 'old');
    assert.equal(first.license.spdx, 'LicenseRef-Unknown');
    assert.equal(first.license.review_required, true);
    const persisted = JSON.parse(store.db.prepare('SELECT license_json FROM shaders WHERE shader_id = ?').get(id).license_json);
    assert.equal(persisted.spdx, 'MIT');
    assert.equal(store.db.prepare('SELECT title FROM shaders WHERE shader_id = ?').get(id).title, newTitle);
    store.db.exec('DROP TRIGGER interleave_read_license_trigger');

    const second = store.getProject(id);
    assert.equal(second.title, newTitle);
    assert.equal(second.renderpasses[0].code, newCode);
    assert.equal(second.rawPayload.Shader.generation, 'new');
    assert.equal(second.license.spdx, 'MIT');
  } finally {
    store.close();
  }
});

test('search keeps its old row snapshot paired with conservative licensing after an interleaved write', () => {
  const store = new LibraryStore(':memory:');
  try {
    const id = 'MslGWN';
    const oldTitle = 'CAS search old target';
    const oldCode = 'void mainImage(out vec4 color, in vec2 fragCoord) { color = vec4(0.20); }';
    const newTitle = 'CAS search new target';
    const newCode = 'void mainImage(out vec4 color, in vec2 fragCoord) { color = vec4(0.80); }';
    const project = makeProject({
      id,
      title: oldTitle,
      rawPayload: { Shader: { info: { id }, generation: 'old' } },
    });
    project.renderpasses[0].code = oldCode;
    const replacement = interleavedExplicitReplacement(id, newTitle, newCode);
    store.upsertProject(project);
    store.db
      .prepare('UPDATE shaders SET license_spdx = ?, license_json = ? WHERE shader_id = ?')
      .run('CC-BY-NC-SA-3.0', JSON.stringify(legacyImplicitDefaultLicense()), id);
    installLicenseCasInterleaveTrigger(store, 'interleave_search_license_trigger', id, replacement);

    const first = store.search('CAS search old target', { limit: 1, offset: 0 });
    assert.equal(first.length, 1);
    assert.equal(first[0].id, id);
    assert.equal(first[0].title, oldTitle);
    assert.equal(first[0].licenseSpdx, 'LicenseRef-Unknown');
    const persisted = JSON.parse(store.db.prepare('SELECT license_json FROM shaders WHERE shader_id = ?').get(id).license_json);
    assert.equal(persisted.spdx, 'MIT');
    store.db.exec('DROP TRIGGER interleave_search_license_trigger');

    const second = store.search('CAS search old target', { limit: 1, offset: 0 });
    assert.equal(second.length, 1);
    assert.equal(second[0].title, newTitle);
    assert.equal(second[0].licenseSpdx, 'MIT');
    const secondProject = store.getProject(id);
    assert.equal(secondProject.renderpasses[0].code, newCode);
    assert.equal(secondProject.rawPayload.Shader.generation, 'new');
    assert.equal(secondProject.license.spdx, 'MIT');
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
