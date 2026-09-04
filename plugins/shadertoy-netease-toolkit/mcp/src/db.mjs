import { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';

import { ANALYZER_VERSION, analyzeProject, assertProjectSourceSize, normalizeProject } from './analyzer.mjs';
import { combineLicenseResults, detectLicense, detectLicenseFromSourceHeader, hasLicenseDeclaration } from './license.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  catalog_count INTEGER NOT NULL DEFAULT 0,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS catalog (
  shader_id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  raw_json_gzip BLOB NOT NULL,
  seen_run_id INTEGER,
  fetch_status TEXT NOT NULL DEFAULT 'pending',
  fetch_error TEXT,
  fetch_attempts INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT,
  FOREIGN KEY (seen_run_id) REFERENCES sync_runs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS shaders (
  shader_id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  published_at TEXT,
  updated_at TEXT,
  viewed INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  source_json TEXT NOT NULL DEFAULT '{}',
  raw_json_gzip BLOB NOT NULL,
  license_spdx TEXT NOT NULL,
  license_json TEXT NOT NULL,
  source_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  stored_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passes (
  shader_id TEXT NOT NULL,
  pass_index INTEGER NOT NULL,
  pass_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL,
  code_bytes INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (shader_id, pass_index),
  FOREIGN KEY (shader_id) REFERENCES shaders(shader_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inputs (
  shader_id TEXT NOT NULL,
  pass_index INTEGER NOT NULL,
  input_index INTEGER NOT NULL,
  channel INTEGER,
  input_id TEXT,
  input_type TEXT,
  source_ref TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (shader_id, pass_index, input_index),
  FOREIGN KEY (shader_id, pass_index) REFERENCES passes(shader_id, pass_index) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outputs (
  shader_id TEXT NOT NULL,
  pass_index INTEGER NOT NULL,
  output_index INTEGER NOT NULL,
  output_id TEXT,
  output_type TEXT,
  output_name TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (shader_id, pass_index, output_index),
  FOREIGN KEY (shader_id, pass_index) REFERENCES passes(shader_id, pass_index) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pass_edges (
  shader_id TEXT NOT NULL,
  from_pass_index INTEGER NOT NULL,
  to_pass_index INTEGER NOT NULL,
  channel INTEGER,
  kind TEXT NOT NULL,
  PRIMARY KEY (shader_id, from_pass_index, to_pass_index, channel),
  FOREIGN KEY (shader_id) REFERENCES shaders(shader_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS analyses (
  shader_id TEXT PRIMARY KEY NOT NULL,
  analyzer_version INTEGER NOT NULL,
  report_json TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  cost_level TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (shader_id) REFERENCES shaders(shader_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS catalog_pending_idx ON catalog(fetch_status, shader_id);
CREATE INDEX IF NOT EXISTS passes_shader_idx ON passes(shader_id, pass_index);
CREATE INDEX IF NOT EXISTS inputs_shader_idx ON inputs(shader_id, pass_index, input_index);
CREATE INDEX IF NOT EXISTS outputs_shader_idx ON outputs(shader_id, pass_index, output_index);
CREATE INDEX IF NOT EXISTS pass_edges_shader_idx ON pass_edges(shader_id);

CREATE VIRTUAL TABLE IF NOT EXISTS shaders_fts USING fts5(
  shader_id UNINDEXED,
  title,
  author,
  description,
  tags
);
`;

function now() {
  return new Date().toISOString();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clampInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, Math.floor(numeric)));
}

function toId(value, label = 'Shader id') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  const id = value.trim();
  if (id.length > 256) {
    throw new RangeError(`${label} exceeds the 256-character safety limit.`);
  }
  return id;
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function gzipJson(value) {
  return gzipSync(Buffer.from(json(value), 'utf8'));
}

function gunzipJson(value, fallback) {
  try {
    return JSON.parse(gunzipSync(Buffer.from(value)).toString('utf8'));
  } catch {
    return fallback;
  }
}

function catalogEntries(value) {
  if (Array.isArray(value)) {
    return value;
  }
  const object = asObject(value);
  for (const key of ['Results', 'results', 'Shaders', 'shaders', 'items', 'catalog']) {
    if (Array.isArray(object[key])) {
      return object[key];
    }
  }
  return [];
}

function catalogItem(item) {
  if (typeof item === 'string') {
    return {
      id: toId(item),
      title: '',
      author: '',
      updatedAt: null,
      raw: { id: item },
    };
  }
  const value = asObject(item);
  const info = asObject(value.info ?? value.Info ?? value.Shader?.info ?? value.shader?.info);
  const id = value.id ?? value.shaderId ?? value.shader_id ?? info.id ?? info.ID;
  return {
    id: toId(id),
    title: optionalString(value.title ?? value.name ?? info.name ?? info.title) ?? '',
    author: optionalString(value.author ?? value.username ?? info.username ?? info.author) ?? '',
    updatedAt: optionalString(value.updatedAt ?? value.updated_at ?? value.updated ?? info.updated ?? info.date),
    raw: item,
  };
}

function sourceReference(input) {
  const value = asObject(input);
  return optionalString(
    value.sourcePass ?? value.pass ?? value.src ?? value.outputId ?? value.buffer ?? value.source ?? value.id,
  );
}

function inputType(input) {
  const value = asObject(input);
  return optionalString(value.ctype ?? value.type ?? value.kind ?? value.sourceType);
}

function outputType(output) {
  const value = asObject(output);
  return optionalString(value.ctype ?? value.type ?? value.kind);
}

function fetchErrorText(error) {
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 2_000);
  }
  if (typeof error === 'string') {
    return error.slice(0, 2_000);
  }
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message) {
      return error.message.slice(0, 2_000);
    }
    if (typeof error.code === 'string' && error.code) {
      return error.code.slice(0, 2_000);
    }
  }
  return 'Unknown fetch error';
}

function ftsQuery(query) {
  if (typeof query !== 'string') {
    return '';
  }
  const compact = query.trim().slice(0, 256);
  if (!compact) {
    return '';
  }
  const terms = compact.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return terms.slice(0, 12).map((term) => `"${term.replace(/"/g, '')}"`).join(' AND ');
}

function storeOptions(options) {
  if (typeof options === 'string') {
    return { path: options };
  }
  return asObject(options);
}

function annotateLicenseEvidence(result, context) {
  return {
    ...result,
    evidence: (result.evidence ?? []).map((entry) => ({ ...entry, ...context })),
  };
}

function metadataLicense(project, normalized, rawPayload) {
  const direct = asObject(project);
  const directMetadata = asObject(direct.metadata ?? direct.remoteMetadata);
  const raw = asObject(rawPayload);
  const rawShader = asObject(raw.Shader ?? raw.shader ?? raw);
  const rawInfo = asObject(rawShader.info ?? rawShader.Info);
  const rawMetadata = asObject(raw.metadata ?? rawShader.metadata ?? rawInfo.metadata);
  const candidates = [
    ['normalized.license', normalized.license],
    ['project.license', direct.license],
    ['project.licenseText', direct.licenseText],
    ['project.licenseName', direct.licenseName],
    ['project.spdx', direct.spdx],
    ['project.spdxId', direct.spdxId],
    ['project.metadata.license', directMetadata.license],
    ['project.metadata.licenseText', directMetadata.licenseText],
    ['project.metadata.licenseName', directMetadata.licenseName],
    ['project.metadata.spdx', directMetadata.spdx],
    ['project.metadata.spdxId', directMetadata.spdxId],
    ['raw.license', raw.license],
    ['raw.licenseText', raw.licenseText],
    ['raw.licenseName', raw.licenseName],
    ['raw.spdx', raw.spdx],
    ['raw.spdxId', raw.spdxId],
    ['raw.Shader.license', rawShader.license],
    ['raw.Shader.licenseText', rawShader.licenseText],
    ['raw.Shader.licenseName', rawShader.licenseName],
    ['raw.Shader.spdx', rawShader.spdx],
    ['raw.Shader.spdxId', rawShader.spdxId],
    ['raw.Shader.info.license', rawInfo.license],
    ['raw.Shader.info.License', rawInfo.License],
    ['raw.Shader.info.licenseText', rawInfo.licenseText],
    ['raw.Shader.info.licenseName', rawInfo.licenseName],
    ['raw.Shader.info.spdx', rawInfo.spdx],
    ['raw.Shader.info.spdxId', rawInfo.spdxId],
    ['raw.metadata.license', rawMetadata.license],
    ['raw.metadata.licenseText', rawMetadata.licenseText],
    ['raw.metadata.licenseName', rawMetadata.licenseName],
    ['raw.metadata.spdx', rawMetadata.spdx],
    ['raw.metadata.spdxId', rawMetadata.spdxId],
  ];
  const results = [];
  for (const [field, candidate] of candidates) {
    if (hasLicenseDeclaration(candidate)) {
      results.push(annotateLicenseEvidence(detectLicense(candidate), { location: 'metadata', field }));
    }
  }
  return combineLicenseResults(results, 'metadata');
}

function resolveProjectLicense(project, normalized, rawPayload) {
  const explicit = metadataLicense(project, normalized, rawPayload);
  if (explicit) {
    return explicit;
  }
  const headerResults = [];
  for (const pass of normalized.renderpasses) {
    const fromHeader = detectLicenseFromSourceHeader(pass.code);
    if (fromHeader) {
      headerResults.push(annotateLicenseEvidence(fromHeader, {
        location: 'source-header',
        passIndex: pass.index,
        passName: pass.name,
      }));
    }
  }
  const headers = combineLicenseResults(headerResults, 'source-header');
  if (headers) {
    return headers;
  }
  return detectLicense();
}

/**
 * Small, parameterized local library store.  Its public surface deliberately
 * contains no generic SQL execution or per-call filesystem paths.
 */
export class LibraryStore {
  constructor(options = {}) {
    const settings = storeOptions(options);
    const path = settings.path ?? settings.filename ?? settings.databasePath ?? ':memory:';
    if (typeof path !== 'string' || !path.trim()) {
      throw new TypeError('LibraryStore path must be a non-empty string.');
    }
    this.path = path;
    this.closed = false;
    this.db = new DatabaseSync(path);
    this.db.prepare('PRAGMA journal_mode = WAL').get();
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`PRAGMA busy_timeout = ${clampInteger(settings.busyTimeoutMs, DEFAULT_BUSY_TIMEOUT_MS, 0, 60_000)}`);
    this.#migrate();
  }

  #assertOpen() {
    if (this.closed) {
      throw new Error('LibraryStore is closed.');
    }
  }

  #transaction(work) {
    this.#assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original write failure; a failed rollback has no safer
        // recovery path on this synchronous, short-lived transaction.
      }
      throw error;
    }
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
    const versionRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    const currentVersion = versionRow ? Number(versionRow.value) : 0;
    if (!Number.isInteger(currentVersion) || currentVersion < 0) {
      throw new Error('Database schema_version is invalid.');
    }
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(`Database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}.`);
    }
    this.#transaction(() => {
      this.db.exec(SCHEMA_SQL);
      this.db
        .prepare(
          `INSERT INTO meta(key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run('schema_version', String(SCHEMA_VERSION));
      this.db
        .prepare(
          `INSERT INTO meta(key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run('schema_updated_at', now());
    });
  }

  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  status() {
    this.#assertOpen();
    const count = (table) => this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    const schemaVersion = Number(this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value);
    return {
      schemaVersion,
      path: this.path,
      counts: {
        catalog: Number(count('catalog')),
        shaders: Number(count('shaders')),
        pending: Number(this.db.prepare(`SELECT COUNT(*) AS count FROM catalog WHERE fetch_status = 'pending'`).get().count),
        analyses: Number(count('analyses')),
      },
      activeSyncRuns: Number(this.db.prepare(`SELECT COUNT(*) AS count FROM sync_runs WHERE status = 'running'`).get().count),
      closed: false,
    };
  }

  beginSync(details = {}) {
    const value = typeof details === 'string' ? { kind: details } : asObject(details);
    const startedAt = optionalString(value.startedAt) ?? now();
    return this.#transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO sync_runs(started_at, status, details_json)
           VALUES (?, 'running', ?)`,
        )
        .run(startedAt, json(value));
      return Number(result.lastInsertRowid);
    });
  }

  finishSync(runId, details = {}) {
    const id = clampInteger(runId, 0, 1, Number.MAX_SAFE_INTEGER);
    if (!id) {
      throw new TypeError('Sync run id must be a positive integer.');
    }
    const value = asObject(details);
    const status = ['success', 'completed', 'failed', 'partial', 'cancelled'].includes(value.status)
      ? value.status
      : 'completed';
    const stats = asObject(value.stats);
    return this.#transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE sync_runs
           SET finished_at = ?, status = ?, catalog_count = ?, fetched_count = ?, error_count = ?, details_json = ?
           WHERE id = ?`,
        )
        .run(
          optionalString(value.finishedAt) ?? now(),
          status,
          clampInteger(value.catalogCount ?? stats.catalogCount ?? stats.marked ?? stats.listed, 0, 0, Number.MAX_SAFE_INTEGER),
          clampInteger(value.fetchedCount ?? stats.fetchedCount ?? stats.upserted ?? stats.fetched, 0, 0, Number.MAX_SAFE_INTEGER),
          clampInteger(value.errorCount ?? stats.errorCount ?? stats.failed, 0, 0, Number.MAX_SAFE_INTEGER),
          json(value),
          id,
        );
      if (!result.changes) {
        throw new Error(`Sync run ${id} does not exist.`);
      }
      return { id, status };
    });
  }

  markCatalog(entriesOrPayload, details = {}) {
    const settings = typeof details === 'number' ? { runId: details } : asObject(details);
    const runId = settings.runId == null ? null : clampInteger(settings.runId, 0, 1, Number.MAX_SAFE_INTEGER);
    if (settings.runId != null && !runId) {
      throw new TypeError('runId must be a positive integer when supplied.');
    }
    const itemsById = new Map();
    for (const entry of catalogEntries(entriesOrPayload)) {
      const item = catalogItem(entry);
      // The official client already de-duplicates IDs, but keeping the store
      // idempotent also protects direct callers and keeps run counts accurate.
      itemsById.set(item.id, item);
    }
    const items = [...itemsById.values()];
    return this.#transaction(() => {
      // A terminal marker remains durable for ordinary resume runs. It is reset
      // only when a distinct catalog sync run has successfully listed the ID
      // again; syncCatalog reaches this method only after validating that list.
      const statement = this.db.prepare(
        `INSERT INTO catalog(shader_id, title, author, updated_at, raw_json_gzip, seen_run_id, fetch_status, fetch_error)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)
         ON CONFLICT(shader_id) DO UPDATE SET
           title = excluded.title,
           author = excluded.author,
           updated_at = excluded.updated_at,
           raw_json_gzip = excluded.raw_json_gzip,
           seen_run_id = excluded.seen_run_id,
            fetch_status = CASE
              WHEN catalog.fetch_status = 'terminal'
                AND excluded.seen_run_id IS NOT NULL
                AND catalog.seen_run_id IS NOT excluded.seen_run_id
                THEN 'pending'
              WHEN catalog.fetch_status IN ('fetched', 'terminal') THEN catalog.fetch_status
              ELSE 'pending'
            END,
            fetch_error = CASE
              WHEN catalog.fetch_status = 'terminal'
                AND excluded.seen_run_id IS NOT NULL
                AND catalog.seen_run_id IS NOT excluded.seen_run_id
                THEN NULL
              WHEN catalog.fetch_status IN ('fetched', 'terminal') THEN catalog.fetch_error
              ELSE NULL
            END,
            fetch_attempts = CASE
              WHEN catalog.fetch_status = 'terminal'
                AND excluded.seen_run_id IS NOT NULL
                AND catalog.seen_run_id IS NOT excluded.seen_run_id
                THEN 0
              ELSE catalog.fetch_attempts
            END,
            fetched_at = CASE
              WHEN catalog.fetch_status = 'terminal'
                AND excluded.seen_run_id IS NOT NULL
                AND catalog.seen_run_id IS NOT excluded.seen_run_id
                THEN NULL
              ELSE catalog.fetched_at
            END`,
      );
      for (const item of items) {
        statement.run(item.id, item.title, item.author, item.updatedAt, gzipJson(item.raw), runId || null);
      }
      if (runId) {
        this.db
          .prepare(
            `UPDATE sync_runs
             SET catalog_count = (SELECT COUNT(*) FROM catalog WHERE seen_run_id = ?)
             WHERE id = ?`,
          )
          .run(runId, runId);
      }
      return { count: items.length, runId: runId || null };
    });
  }

  listPending(options = {}) {
    this.#assertOpen();
    const settings = typeof options === 'number' ? { limit: options } : asObject(options);
    const limit = clampInteger(settings.limit, 100, 1, 500);
    const rows = this.db
      .prepare(
        `SELECT shader_id, title, author, updated_at, raw_json_gzip, fetch_attempts, fetch_error
         FROM catalog WHERE fetch_status = 'pending'
         ORDER BY shader_id LIMIT ?`,
      )
      .all(limit);
    return rows.map((row) => ({
      id: row.shader_id,
      title: row.title,
      author: row.author,
      updatedAt: row.updated_at,
      rawPayload: gunzipJson(row.raw_json_gzip, null),
      fetchAttempts: Number(row.fetch_attempts),
      fetchError: row.fetch_error,
    }));
  }

  countPending() {
    this.#assertOpen();
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM catalog WHERE fetch_status = 'pending'`).get().count);
  }

  markFetchError(shaderId, error) {
    const id = toId(shaderId);
    const message = fetchErrorText(error);
    return this.#transaction(() => {
      this.db
        .prepare(
          `INSERT INTO catalog(shader_id, raw_json_gzip, fetch_status, fetch_error, fetch_attempts)
           VALUES (?, ?, 'pending', ?, 1)
           ON CONFLICT(shader_id) DO UPDATE SET
             fetch_status = 'pending',
             fetch_error = excluded.fetch_error,
             fetch_attempts = catalog.fetch_attempts + 1`,
        )
        .run(id, gzipJson({ id }), message);
      return { id, fetchStatus: 'pending', error: message };
    });
  }

  markFetchTerminal(shaderId, error) {
    const id = toId(shaderId);
    const message = fetchErrorText(error);
    return this.#transaction(() => {
      this.db
        .prepare(
          `INSERT INTO catalog(shader_id, raw_json_gzip, fetch_status, fetch_error, fetch_attempts)
           VALUES (?, ?, 'terminal', ?, 1)
           ON CONFLICT(shader_id) DO UPDATE SET
             fetch_status = 'terminal',
             fetch_error = excluded.fetch_error,
             fetch_attempts = catalog.fetch_attempts + 1`,
        )
        .run(id, gzipJson({ id }), message);
      return { id, fetchStatus: 'terminal', error: message };
    });
  }

  upsertProject(project, options = {}) {
    this.#assertOpen();
    const normalized = normalizeProject(project);
    const id = toId(normalized.id);
    const sourceBytes = assertProjectSourceSize(project);
    const analysis = analyzeProject(normalized);
    const rawPayload = asObject(project).rawPayload ?? asObject(project).official ?? asObject(project).raw ?? project;
    const license = resolveProjectLicense(project, normalized, rawPayload);
    const settings = asObject(options);
    const syncRunId = settings.syncRunId == null
      ? null
      : clampInteger(settings.syncRunId, 0, 1, Number.MAX_SAFE_INTEGER);
    if (settings.syncRunId != null && !syncRunId) {
      throw new TypeError('syncRunId must be a positive integer when supplied.');
    }
    const timestamp = now();
    const passByNodeId = new Map(normalized.renderpasses.map((pass) => [`pass:${pass.index}`, pass.index]));
    return this.#transaction(() => {
      const existing = this.db.prepare('SELECT 1 FROM shaders WHERE shader_id = ?').get(id);
      this.db
        .prepare(
          `INSERT INTO shaders(
             shader_id, title, author, description, tags_json, published_at, updated_at, viewed, likes,
             source_json, raw_json_gzip, license_spdx, license_json, source_bytes, created_at, stored_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(shader_id) DO UPDATE SET
             title = excluded.title, author = excluded.author, description = excluded.description,
             tags_json = excluded.tags_json, published_at = excluded.published_at, updated_at = excluded.updated_at,
             viewed = excluded.viewed, likes = excluded.likes, source_json = excluded.source_json,
             raw_json_gzip = excluded.raw_json_gzip, license_spdx = excluded.license_spdx,
             license_json = excluded.license_json, source_bytes = excluded.source_bytes, stored_at = excluded.stored_at`,
        )
        .run(
          id,
          normalized.title,
          normalized.author,
          normalized.description,
          json(normalized.tags),
          optionalString(normalized.publishedAt),
          optionalString(normalized.updatedAt),
          normalized.viewed,
          normalized.likes,
          json(normalized.source),
          gzipJson(rawPayload),
          license.spdx,
          json(license),
          sourceBytes,
          timestamp,
          timestamp,
        );

      this.db.prepare('DELETE FROM passes WHERE shader_id = ?').run(id);
      const passStatement = this.db.prepare(
        `INSERT INTO passes(shader_id, pass_index, pass_id, name, type, description, code, code_bytes, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const inputStatement = this.db.prepare(
        `INSERT INTO inputs(shader_id, pass_index, input_index, channel, input_id, input_type, source_ref, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const outputStatement = this.db.prepare(
        `INSERT INTO outputs(shader_id, pass_index, output_index, output_id, output_type, output_name, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const pass of normalized.renderpasses) {
        passStatement.run(
          id,
          pass.index,
          optionalString(pass.id),
          pass.name,
          pass.type,
          pass.description,
          pass.code,
          Buffer.byteLength(pass.code, 'utf8'),
          json(pass),
        );
        pass.inputs.forEach((input, inputIndex) => {
          const value = asObject(input);
          inputStatement.run(
            id,
            pass.index,
            inputIndex,
            Number.isFinite(Number(value.channel ?? value.index ?? value.slot))
              ? Number(value.channel ?? value.index ?? value.slot)
              : null,
            optionalString(value.id ?? value.ID ?? value.inputId),
            inputType(value),
            sourceReference(value),
            json(input),
          );
        });
        pass.outputs.forEach((output, outputIndex) => {
          const value = asObject(output);
          outputStatement.run(
            id,
            pass.index,
            outputIndex,
            optionalString(value.id ?? value.ID ?? value.outputId),
            outputType(value),
            optionalString(value.name ?? value.label),
            json(output),
          );
        });
      }

      this.db.prepare('DELETE FROM pass_edges WHERE shader_id = ?').run(id);
      const edgeStatement = this.db.prepare(
        `INSERT INTO pass_edges(shader_id, from_pass_index, to_pass_index, channel, kind)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const edge of analysis.graph.edges) {
        const from = passByNodeId.get(edge.from);
        const to = passByNodeId.get(edge.to);
        if (from != null && to != null) {
          edgeStatement.run(id, from, to, edge.channel ?? null, edge.kind);
        }
      }
      this.db
        .prepare(
          `INSERT INTO analyses(shader_id, analyzer_version, report_json, graph_json, cost_level, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(shader_id) DO UPDATE SET
             analyzer_version = excluded.analyzer_version,
             report_json = excluded.report_json,
             graph_json = excluded.graph_json,
             cost_level = excluded.cost_level,
             created_at = excluded.created_at`,
        )
        .run(id, ANALYZER_VERSION, json(analysis), json(analysis.graph), analysis.costLevel, timestamp);

      this.db.prepare('DELETE FROM shaders_fts WHERE shader_id = ?').run(id);
      this.db
        .prepare('INSERT INTO shaders_fts(shader_id, title, author, description, tags) VALUES (?, ?, ?, ?, ?)')
        .run(id, normalized.title, normalized.author, normalized.description, normalized.tags.join(' '));
      this.db
        .prepare(
          `INSERT INTO catalog(shader_id, title, author, updated_at, raw_json_gzip, fetch_status, fetch_error, fetched_at)
           VALUES (?, ?, ?, ?, ?, 'fetched', NULL, ?)
           ON CONFLICT(shader_id) DO UPDATE SET
             title = excluded.title, author = excluded.author, updated_at = excluded.updated_at,
             fetch_status = 'fetched', fetch_error = NULL, fetched_at = excluded.fetched_at`,
        )
        .run(id, normalized.title, normalized.author, optionalString(normalized.updatedAt), gzipJson({ id }), timestamp);
      if (syncRunId) {
        this.db.prepare('UPDATE sync_runs SET fetched_count = fetched_count + 1 WHERE id = ?').run(syncRunId);
      }
      return { id, created: !existing, updated: Boolean(existing), sourceBytes, license, analysis };
    });
  }

  getProject(shaderId) {
    this.#assertOpen();
    const id = toId(shaderId);
    const shader = this.db.prepare('SELECT * FROM shaders WHERE shader_id = ?').get(id);
    if (!shader) {
      return null;
    }
    const passes = this.db
      .prepare('SELECT * FROM passes WHERE shader_id = ? ORDER BY pass_index')
      .all(id)
      .map((row) => ({
        index: Number(row.pass_index),
        id: row.pass_id ?? '',
        name: row.name,
        type: row.type,
        description: row.description,
        code: row.code,
        inputs: [],
        outputs: [],
      }));
    const passByIndex = new Map(passes.map((pass) => [pass.index, pass]));
    for (const row of this.db.prepare('SELECT * FROM inputs WHERE shader_id = ? ORDER BY pass_index, input_index').all(id)) {
      const pass = passByIndex.get(Number(row.pass_index));
      if (pass) {
        pass.inputs.push(parseJson(row.raw_json, {
          channel: row.channel,
          id: row.input_id,
          ctype: row.input_type,
          src: row.source_ref,
        }));
      }
    }
    for (const row of this.db.prepare('SELECT * FROM outputs WHERE shader_id = ? ORDER BY pass_index, output_index').all(id)) {
      const pass = passByIndex.get(Number(row.pass_index));
      if (pass) {
        pass.outputs.push(parseJson(row.raw_json, {
          id: row.output_id,
          ctype: row.output_type,
          name: row.output_name,
        }));
      }
    }
    const analysisRow = this.db.prepare('SELECT * FROM analyses WHERE shader_id = ?').get(id);
    const analysis = analysisRow ? parseJson(analysisRow.report_json, null) : null;
    const rawPayload = gunzipJson(shader.raw_json_gzip, null);
    const source = parseJson(shader.source_json, {});
    const project = {
      id: shader.shader_id,
      title: shader.title,
      author: shader.author,
      description: shader.description,
      tags: parseJson(shader.tags_json, []),
      publishedAt: shader.published_at,
      updatedAt: shader.updated_at,
      viewed: Number(shader.viewed),
      likes: Number(shader.likes),
      source,
      renderpasses: passes,
      license: parseJson(shader.license_json, detectLicense()),
      sourceBytes: Number(shader.source_bytes),
      createdAt: shader.created_at,
      storedAt: shader.stored_at,
      rawPayload,
      analysis,
      passGraph: analysis?.graph ?? (analysisRow ? parseJson(analysisRow.graph_json, null) : null),
    };
    // `passes` and `official` keep callers of the early internal prototype
    // compatible while canonical MCP data uses `renderpasses`/`rawPayload`.
    return { ...project, passes: project.renderpasses, official: rawPayload };
  }

  search(query, options = {}) {
    this.#assertOpen();
    const match = ftsQuery(query);
    if (!match) {
      return [];
    }
    const settings = typeof options === 'number' ? { limit: options } : asObject(options);
    const limit = clampInteger(settings.limit, 20, 1, 100);
    const offset = clampInteger(settings.offset, 0, 0, 10_000);
    const rows = this.db
      .prepare(
        `SELECT s.shader_id, s.title, s.author, s.description, s.tags_json, s.updated_at, s.license_spdx,
                bm25(shaders_fts) AS score
         FROM shaders_fts
         JOIN shaders AS s ON s.shader_id = shaders_fts.shader_id
         WHERE shaders_fts MATCH ?
         ORDER BY score, s.shader_id
         LIMIT ? OFFSET ?`,
      )
      .all(match, limit, offset);
    return rows.map((row) => ({
      id: row.shader_id,
      title: row.title,
      author: row.author,
      description: row.description,
      tags: parseJson(row.tags_json, []),
      updatedAt: row.updated_at,
      licenseSpdx: row.license_spdx,
      score: Number(row.score),
    }));
  }
}

export const LIBRARY_SCHEMA_VERSION = SCHEMA_VERSION;
