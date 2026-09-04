import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Schema version for the provider-neutral, local resource cache.  This store
 * intentionally does not share the legacy Shadertoy database so a provider
 * rollout cannot change its existing cache or migration contract.
 */
export const SOURCE_STORE_SCHEMA_VERSION = 3;

const DEFAULT_DATABASE_PATH = 'resources-v2.sqlite3';
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_STRING_BYTES = 32 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_QUERY_BYTES = 256;
const MAX_BLOB_COUNT = 64;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_RESOURCE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_LIMIT = 100;
const MAX_PAGE_OFFSET = 1_000_000;
const MAX_RECONCILIATION_IDS = 10_000;
const MAX_RECONCILIATION_TOTAL_BYTES = MAX_JSON_BYTES;
const DEFAULT_PROVIDER_SYNC_LEASE_MS = 120_000;
const MIN_PROVIDER_SYNC_LEASE_MS = 1_000;
const MAX_PROVIDER_SYNC_LEASE_MS = 5 * 60_000;
const RESOURCE_KINDS = new Set(['shader', 'knowledge']);
const RECONCILIATION_IDS_TABLE = 'source_store_reconciliation_ids';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resources (
  provider TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('shader', 'knowledge')),
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  language TEXT,
  canonical_url TEXT,
  rights_json TEXT,
  provenance_json TEXT,
  authorization_json TEXT,
  content_policy_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  license_spdx TEXT,
  review_required INTEGER NOT NULL DEFAULT 1 CHECK(review_required IN (0, 1)),
  body_bytes INTEGER NOT NULL DEFAULT 0 CHECK(body_bytes >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, resource_id)
);

CREATE TABLE IF NOT EXISTS resource_blobs (
  provider TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  role TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  body_gzip BLOB NOT NULL,
  body_bytes INTEGER NOT NULL CHECK(body_bytes >= 0),
  body_encoding TEXT NOT NULL CHECK(body_encoding IN ('utf8', 'binary')),
  PRIMARY KEY (provider, resource_id, role),
  FOREIGN KEY (provider, resource_id)
    REFERENCES resources(provider, resource_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_sync_state (
  provider TEXT PRIMARY KEY NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_sync_lease (
  provider TEXT PRIMARY KEY NOT NULL,
  run_token TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  active_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS resources_kind_idx
  ON resources(kind, title COLLATE NOCASE, provider, resource_id);
CREATE INDEX IF NOT EXISTS resources_provider_kind_idx
  ON resources(provider, kind, title COLLATE NOCASE, resource_id);
CREATE INDEX IF NOT EXISTS resource_blobs_resource_idx
  ON resource_blobs(provider, resource_id, role);
CREATE INDEX IF NOT EXISTS provider_sync_lease_expiry_idx
  ON provider_sync_lease(expires_at_ms);

CREATE VIRTUAL TABLE IF NOT EXISTS resource_fts USING fts5(
  provider UNINDEXED,
  resource_id UNINDEXED,
  title,
  author,
  description,
  tags,
  content
);
`;

function now() {
  return new Date().toISOString();
}

export class ProviderSyncLeaseError extends Error {
  constructor() {
    super('The provider sync lease is no longer available.');
    this.name = 'ProviderSyncLeaseError';
    this.code = 'sync_in_progress';
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asOptions(value) {
  if (typeof value === 'string') {
    return { path: value };
  }
  if (value === undefined || value === null) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new TypeError('SourceStore options must be a path string or an object.');
  }
  return value;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function limitedString(value, label, maximum = MAX_STRING_BYTES) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string.`);
  }
  const text = value.trim();
  if (!text) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (byteLength(text) > maximum) {
    throw new RangeError(`${label} exceeds the ${maximum}-byte safety limit.`);
  }
  return text;
}

function normalizeProviderSyncRunToken(value) {
  const token = limitedString(value, 'Provider sync run token', 128);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(token)) {
    throw new TypeError('Provider sync run token is invalid.');
  }
  return token;
}

function optionalString(value, label, maximum = MAX_STRING_BYTES) {
  if (value === undefined || value === null) {
    return null;
  }
  return limitedString(value, label, maximum);
}

function optionalText(value, label, maximum = MAX_STRING_BYTES) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string.`);
  }
  const text = value.trim();
  if (byteLength(text) > maximum) {
    throw new RangeError(`${label} exceeds the ${maximum}-byte safety limit.`);
  }
  return text;
}

function clampInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError('Pagination values must be finite numbers.');
  }
  return Math.max(minimum, Math.min(maximum, Math.floor(numeric)));
}

function normalizeRef(value, label = 'Resource ref') {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be an object with provider and id.`);
  }
  return {
    provider: limitedString(value.provider, `${label}.provider`, 256),
    id: limitedString(value.id, `${label}.id`, 256),
  };
}

function normalizeTags(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError('record.tags must be an array of strings.');
  }
  if (value.length > 128) {
    throw new RangeError('record.tags exceeds the 128-tag safety limit.');
  }
  const seen = new Set();
  const tags = [];
  for (const tag of value) {
    const normalized = limitedString(tag, 'record.tags entry', 256);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      tags.push(normalized);
    }
  }
  return tags;
}

function encodeJson(value, label, { fallback = null, objectOnly = true } = {}) {
  if (value === undefined || value === null) {
    if (fallback === null) {
      return { value: null, json: null };
    }
    return encodeJson(fallback, label, { objectOnly });
  }
  if (objectOnly && !isPlainObject(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable: ${error.message}`);
  }
  if (typeof serialized !== 'string') {
    throw new TypeError(`${label} must be JSON-serializable.`);
  }
  if (byteLength(serialized) > MAX_JSON_BYTES) {
    throw new RangeError(`${label} exceeds the ${MAX_JSON_BYTES}-byte JSON safety limit.`);
  }
  let cloned;
  try {
    cloned = JSON.parse(serialized);
  } catch {
    throw new TypeError(`${label} could not be normalized as JSON.`);
  }
  if (objectOnly && !isPlainObject(cloned)) {
    throw new TypeError(`${label} must normalize to a JSON object.`);
  }
  return { value: cloned, json: serialized };
}

function normalizeCanonicalUrl(value) {
  const text = optionalString(value, 'record.canonicalUrl', 4 * 1024);
  if (!text) {
    return null;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError('record.canonicalUrl must be an absolute HTTP(S) URL.');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new TypeError('record.canonicalUrl must be an absolute HTTP(S) URL without credentials.');
  }
  return url.toString();
}

function normalizeRights(value) {
  const encoded = encodeJson(value, 'record.rights');
  if (!encoded.value) {
    return {
      rights: null,
      rightsJson: null,
      licenseSpdx: null,
      reviewRequired: true,
    };
  }
  const rights = encoded.value;
  const spdx = optionalString(
    rights.spdx ?? rights.licenseSpdx ?? rights.license_spdx,
    'record.rights SPDX identifier',
    256,
  );
  const explicitlyReviewable = rights.reviewRequired === true
    || rights.review_required === true
    || rights.status === 'review'
    || rights.status === 'review_required';
  return {
    rights,
    rightsJson: encoded.json,
    licenseSpdx: spdx,
    // A provider-neutral source is never granted a site-specific default
    // license.  Rights without an SPDX identifier remain reviewable.
    reviewRequired: explicitlyReviewable || !spdx,
  };
}

function normalizeContentPolicy(value) {
  if (value === undefined || value === null) {
    return { contentPolicy: null, contentPolicyJson: null, mode: null, linkOnly: false };
  }
  if (typeof value === 'string') {
    const mode = limitedString(value, 'record.contentPolicy', 256);
    return {
      contentPolicy: mode,
      contentPolicyJson: JSON.stringify(mode),
      mode,
      linkOnly: mode === 'link_only',
    };
  }
  const encoded = encodeJson(value, 'record.contentPolicy');
  const mode = optionalString(encoded.value.mode, 'record.contentPolicy.mode', 256);
  return {
    contentPolicy: encoded.value,
    contentPolicyJson: encoded.json,
    mode,
    linkOnly: mode === 'link_only',
  };
}

function blobBody(value) {
  if (typeof value === 'string') {
    return { bytes: Buffer.from(value, 'utf8'), encoding: 'utf8' };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { bytes: Buffer.from(value), encoding: 'binary' };
  }
  throw new TypeError('blob.body must be a string, Buffer, or Uint8Array.');
}

function normalizeBlobs(value, linkOnly) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError('record.blobs must be an array.');
  }
  if (value.length > MAX_BLOB_COUNT) {
    throw new RangeError(`record.blobs exceeds the ${MAX_BLOB_COUNT}-blob safety limit.`);
  }
  if (linkOnly && value.length > 0) {
    throw new TypeError('link_only resources cannot store blobs.');
  }
  const roles = new Set();
  let totalBytes = 0;
  const blobs = value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new TypeError(`record.blobs[${index}] must be an object.`);
    }
    const role = limitedString(item.role, `record.blobs[${index}].role`, 256);
    const mimeType = limitedString(item.mimeType, `record.blobs[${index}].mimeType`, 256);
    if (roles.has(role)) {
      throw new TypeError(`record.blobs contains duplicate role "${role}".`);
    }
    roles.add(role);
    const body = blobBody(item.body);
    if (body.bytes.byteLength > MAX_BLOB_BYTES) {
      throw new RangeError(`record.blobs[${index}] exceeds the ${MAX_BLOB_BYTES}-byte body limit.`);
    }
    totalBytes += body.bytes.byteLength;
    if (totalBytes > MAX_RESOURCE_BODY_BYTES) {
      throw new RangeError(`record.blobs exceeds the ${MAX_RESOURCE_BODY_BYTES}-byte total body limit.`);
    }
    return {
      role,
      mimeType,
      body: body.bytes,
      encoding: body.encoding,
      bodyBytes: body.bytes.byteLength,
      bodyGzip: gzipSync(body.bytes),
    };
  });
  return blobs;
}

function normalizeRecord(record) {
  if (!isPlainObject(record)) {
    throw new TypeError('Resource record must be an object.');
  }
  const ref = normalizeRef(record.ref, 'record.ref');
  if (!RESOURCE_KINDS.has(record.kind)) {
    throw new TypeError('record.kind must be either "shader" or "knowledge".');
  }
  const title = limitedString(record.title, 'record.title', 4 * 1024);
  const author = optionalText(record.author, 'record.author', 4 * 1024);
  const description = optionalText(record.description, 'record.description', MAX_STRING_BYTES);
  const tags = normalizeTags(record.tags);
  const language = optionalString(record.language, 'record.language', 256);
  const canonicalUrl = normalizeCanonicalUrl(record.canonicalUrl);
  const rights = normalizeRights(record.rights);
  const provenance = encodeJson(record.provenance, 'record.provenance');
  const authorization = encodeJson(record.authorization, 'record.authorization');
  const contentPolicy = normalizeContentPolicy(record.contentPolicy);
  const metadata = encodeJson(record.metadata, 'record.metadata', { fallback: {} });
  const blobs = normalizeBlobs(record.blobs, contentPolicy.linkOnly);
  const bodyBytes = blobs.reduce((total, blob) => total + blob.bodyBytes, 0);
  // Full text is deliberately opt-in and applies only to public knowledge
  // resources.  Shader source, user-authorized source, link-only resources,
  // metadata-only records, and every other policy remain out of FTS.
  const fullTextContent = record.kind === 'knowledge' && contentPolicy.mode === 'full_text'
    ? blobs
      .filter((blob) => blob.encoding === 'utf8')
      .map((blob) => blob.body.toString('utf8'))
      .join('\n')
    : '';
  return {
    ref,
    kind: record.kind,
    title,
    author,
    description,
    tags,
    tagsJson: JSON.stringify(tags),
    language,
    canonicalUrl,
    ...rights,
    provenance: provenance.value,
    provenanceJson: provenance.json,
    authorization: authorization.value,
    authorizationJson: authorization.json,
    contentPolicy: contentPolicy.contentPolicy,
    contentPolicyJson: contentPolicy.contentPolicyJson,
    fullTextContent,
    metadata: metadata.value,
    metadataJson: metadata.json,
    blobs,
    bodyBytes,
  };
}

function decodeJson(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function decodeBlob(row) {
  let body;
  try {
    body = gunzipSync(Buffer.from(row.body_gzip), { maxOutputLength: MAX_BLOB_BYTES + 1 });
  } catch (error) {
    throw new Error(`Stored blob ${row.role} could not be decompressed: ${error.message}`);
  }
  if (body.byteLength !== Number(row.body_bytes) || body.byteLength > MAX_BLOB_BYTES) {
    throw new Error(`Stored blob ${row.role} violates its body-size contract.`);
  }
  return {
    role: row.role,
    mimeType: row.mime_type,
    body: row.body_encoding === 'utf8' ? body.toString('utf8') : body,
  };
}

function rowToResource(row, blobs = []) {
  return {
    ref: { provider: row.provider, id: row.resource_id },
    kind: row.kind,
    title: row.title,
    author: row.author,
    description: row.description,
    tags: decodeJson(row.tags_json, []),
    language: row.language,
    canonicalUrl: row.canonical_url,
    rights: decodeJson(row.rights_json, null),
    provenance: decodeJson(row.provenance_json, null),
    authorization: decodeJson(row.authorization_json, null),
    contentPolicy: decodeJson(row.content_policy_json, null),
    metadata: decodeJson(row.metadata_json, {}),
    licenseSpdx: row.license_spdx,
    reviewRequired: Boolean(row.review_required),
    bodyBytes: Number(row.body_bytes),
    blobCount: row.blob_count === undefined ? blobs.length : Number(row.blob_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blobs,
  };
}

function rowToSummary(row) {
  const resource = rowToResource(row);
  delete resource.blobs;
  return resource;
}

function ftsQuery(query) {
  if (typeof query !== 'string') {
    throw new TypeError('search query must be a string.');
  }
  const compact = query.trim();
  if (byteLength(compact) > MAX_QUERY_BYTES) {
    throw new RangeError(`search query exceeds the ${MAX_QUERY_BYTES}-byte safety limit.`);
  }
  if (!compact) {
    return '';
  }
  const terms = compact.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return terms.slice(0, 12).map((term) => `"${term.replace(/"/g, '')}"`).join(' AND ');
}

function normalizeSearchOptions(value) {
  if (value === undefined || value === null) {
    return { provider: null, kind: null, limit: 20, offset: 0 };
  }
  if (!isPlainObject(value)) {
    throw new TypeError('search options must be an object.');
  }
  const provider = value.provider === undefined || value.provider === null
    ? null
    : limitedString(value.provider, 'search provider', 256);
  const kind = value.kind === undefined || value.kind === null ? null : value.kind;
  if (kind !== null && !RESOURCE_KINDS.has(kind)) {
    throw new TypeError('search kind must be either "shader" or "knowledge".');
  }
  return {
    provider,
    kind,
    limit: clampInteger(value.limit, 20, 1, MAX_PAGE_LIMIT),
    offset: clampInteger(value.offset, 0, 0, MAX_PAGE_OFFSET),
  };
}

function normalizeSyncState(provider, state) {
  const normalizedProvider = limitedString(provider, 'Sync-state provider', 256);
  const encoded = encodeJson(state, 'Sync state', { fallback: {} });
  const value = { ...encoded.value };
  value.revision = optionalString(value.revision, 'Sync state.revision', 4 * 1024);
  value.cursor = optionalString(value.cursor, 'Sync state.cursor', 16 * 1024);
  value.status = optionalString(value.status, 'Sync state.status', 256) ?? 'idle';
  value.updatedAt = optionalString(value.updatedAt, 'Sync state.updatedAt', 256) ?? now();
  const normalized = encodeJson(value, 'Sync state');
  return {
    provider: normalizedProvider,
    state: normalized.value,
    stateJson: normalized.json,
    updatedAt: normalized.value.updatedAt,
  };
}

function normalizeEligibleResourceIds(value) {
  if (!Array.isArray(value)) {
    throw new TypeError('Eligible resource ids must be an array.');
  }
  if (value.length > MAX_RECONCILIATION_IDS) {
    throw new RangeError(`Eligible resource ids exceeds the ${MAX_RECONCILIATION_IDS}-id safety limit.`);
  }
  if (value.length === 0) {
    throw new TypeError('Provider reconciliation requires at least one eligible resource id.');
  }
  const ids = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const [index, candidate] of value.entries()) {
    const id = limitedString(candidate, `Eligible resource id at index ${index}`);
    totalBytes += byteLength(id);
    if (totalBytes > MAX_RECONCILIATION_TOTAL_BYTES) {
      throw new RangeError(`Eligible resource ids exceeds the ${MAX_RECONCILIATION_TOTAL_BYTES}-byte safety limit.`);
    }
    if (seen.has(id)) {
      throw new TypeError(`Eligible resource ids contains duplicate id "${id}".`);
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeReconciliationScope(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (value !== 'built-in-original-topic-index') {
    throw new TypeError('Provider reconciliation scope is not supported.');
  }
  return value;
}

/**
 * Provider-neutral resource cache.  The public surface deliberately contains
 * no generic SQL or arbitrary filesystem/path APIs.
 */
export class SourceStore {
  constructor(options = {}) {
    const settings = asOptions(options);
    const path = settings.path ?? settings.filename ?? DEFAULT_DATABASE_PATH;
    if (typeof path !== 'string' || !path.trim()) {
      throw new TypeError('SourceStore path must be a non-empty string.');
    }
    this.path = path;
    this.closed = false;
    const syncClock = settings.syncClock ?? Date.now;
    if (typeof syncClock !== 'function') {
      throw new TypeError('SourceStore syncClock must be a function.');
    }
    this.syncClock = syncClock;
    this.providerSyncLeaseMs = clampInteger(
      settings.providerSyncLeaseMs,
      DEFAULT_PROVIDER_SYNC_LEASE_MS,
      MIN_PROVIDER_SYNC_LEASE_MS,
      MAX_PROVIDER_SYNC_LEASE_MS,
    );
    this.db = new DatabaseSync(path);
    this.db.prepare('PRAGMA journal_mode = WAL').get();
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA trusted_schema = OFF');
    this.db.exec(`PRAGMA busy_timeout = ${clampInteger(settings.busyTimeoutMs, DEFAULT_BUSY_TIMEOUT_MS, 0, 60_000)}`);
    this.#migrate();
    // Completion reconciliation is local to this database connection.  It is
    // populated and cleared inside the same write transaction as the final
    // provider state, so a partial or failed sync can never delete resources.
    this.db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${RECONCILIATION_IDS_TABLE} (
      resource_id TEXT PRIMARY KEY NOT NULL
    )`);
  }

  #assertOpen() {
    if (this.closed) {
      throw new Error('SourceStore is closed.');
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
        // Preserve the write failure.  The store never continues a failed
        // transaction and therefore cannot safely repair it here.
      }
      throw error;
    }
  }

  #currentSyncTimeMs() {
    const value = Number(this.syncClock());
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - MAX_PROVIDER_SYNC_LEASE_MS) {
      throw new RangeError('SourceStore syncClock returned an invalid timestamp.');
    }
    return Math.floor(value);
  }

  #claimableLeaseExpiry(nowMs) {
    const expiry = nowMs + this.providerSyncLeaseMs;
    if (!Number.isSafeInteger(expiry)) {
      throw new RangeError('Provider sync lease expiry is invalid.');
    }
    return expiry;
  }

  #assertAndRenewProviderSyncLease(provider, runToken, revision = null) {
    const normalizedRevision = revision === null
      ? null
      : limitedString(revision, 'Provider sync revision', 4 * 1024);
    const nowMs = this.#currentSyncTimeMs();
    const lease = this.db
      .prepare('SELECT run_token, expires_at_ms, active_revision FROM provider_sync_lease WHERE provider = ?')
      .get(provider);
    if (!lease || lease.run_token !== runToken || !Number.isSafeInteger(Number(lease.expires_at_ms)) || Number(lease.expires_at_ms) <= nowMs) {
      throw new ProviderSyncLeaseError();
    }
    if (normalizedRevision !== null && lease.active_revision !== null && lease.active_revision !== normalizedRevision) {
      throw new ProviderSyncLeaseError();
    }
    const renewal = this.db
      .prepare(
        `UPDATE provider_sync_lease
         SET expires_at_ms = ?,
             active_revision = COALESCE(active_revision, ?),
             updated_at = ?
         WHERE provider = ? AND run_token = ? AND expires_at_ms > ?`,
      )
      .run(this.#claimableLeaseExpiry(nowMs), normalizedRevision, now(), provider, runToken, nowMs);
    if (Number(renewal.changes) !== 1) {
      throw new ProviderSyncLeaseError();
    }
  }

  #writeSyncState(normalized) {
    this.db
      .prepare(
        `INSERT INTO provider_sync_state(provider, state_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(normalized.provider, normalized.stateJson, normalized.updatedAt);
    return { provider: normalized.provider, ...normalized.state };
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    const currentVersion = row ? Number(row.value) : 0;
    if (!Number.isInteger(currentVersion) || currentVersion < 0) {
      throw new Error('SourceStore schema_version is invalid.');
    }
    if (currentVersion > SOURCE_STORE_SCHEMA_VERSION) {
      throw new Error(
        `SourceStore schema version ${currentVersion} is newer than supported version ${SOURCE_STORE_SCHEMA_VERSION}.`,
      );
    }
    this.#transaction(() => {
      this.db.exec(SCHEMA_SQL);
      const leaseColumns = this.db.prepare('PRAGMA table_info(provider_sync_lease)').all();
      if (!leaseColumns.some((column) => column.name === 'active_revision')) {
        this.db.exec('ALTER TABLE provider_sync_lease ADD COLUMN active_revision TEXT');
      }
      this.db
        .prepare(
          `INSERT INTO meta(key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run('schema_version', String(SOURCE_STORE_SCHEMA_VERSION));
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
    const count = (table) => Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    const schemaVersion = Number(this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value);
    return {
      schemaVersion,
      path: this.path,
      counts: {
        resources: count('resources'),
        shaders: Number(this.db.prepare(`SELECT COUNT(*) AS count FROM resources WHERE kind = 'shader'`).get().count),
        knowledge: Number(this.db.prepare(`SELECT COUNT(*) AS count FROM resources WHERE kind = 'knowledge'`).get().count),
        blobs: count('resource_blobs'),
        providerSyncStates: count('provider_sync_state'),
        providerSyncLeases: count('provider_sync_lease'),
      },
      closed: false,
    };
  }

  #upsertNormalizedResource(resource, timestamp) {
    const existing = this.db
      .prepare('SELECT 1 AS exists_row FROM resources WHERE provider = ? AND resource_id = ?')
      .get(resource.ref.provider, resource.ref.id);
    this.db
      .prepare(
        `INSERT INTO resources(
           provider, resource_id, kind, title, author, description, tags_json,
           language, canonical_url, rights_json, provenance_json, authorization_json,
           content_policy_json, metadata_json, license_spdx, review_required,
           body_bytes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, resource_id) DO UPDATE SET
           kind = excluded.kind,
           title = excluded.title,
           author = excluded.author,
           description = excluded.description,
           tags_json = excluded.tags_json,
           language = excluded.language,
           canonical_url = excluded.canonical_url,
           rights_json = excluded.rights_json,
           provenance_json = excluded.provenance_json,
           authorization_json = excluded.authorization_json,
           content_policy_json = excluded.content_policy_json,
           metadata_json = excluded.metadata_json,
           license_spdx = excluded.license_spdx,
           review_required = excluded.review_required,
           body_bytes = excluded.body_bytes,
           updated_at = excluded.updated_at`,
      )
      .run(
        resource.ref.provider,
        resource.ref.id,
        resource.kind,
        resource.title,
        resource.author,
        resource.description,
        resource.tagsJson,
        resource.language,
        resource.canonicalUrl,
        resource.rightsJson,
        resource.provenanceJson,
        resource.authorizationJson,
        resource.contentPolicyJson,
        resource.metadataJson,
        resource.licenseSpdx,
        resource.reviewRequired ? 1 : 0,
        resource.bodyBytes,
        timestamp,
        timestamp,
      );
    this.db
      .prepare('DELETE FROM resource_blobs WHERE provider = ? AND resource_id = ?')
      .run(resource.ref.provider, resource.ref.id);
    const insertBlob = this.db.prepare(
      `INSERT INTO resource_blobs(
         provider, resource_id, role, mime_type, body_gzip, body_bytes, body_encoding
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const blob of resource.blobs) {
      insertBlob.run(
        resource.ref.provider,
        resource.ref.id,
        blob.role,
        blob.mimeType,
        blob.bodyGzip,
        blob.bodyBytes,
        blob.encoding,
      );
    }
    this.db
      .prepare('DELETE FROM resource_fts WHERE provider = ? AND resource_id = ?')
      .run(resource.ref.provider, resource.ref.id);
    this.db
      .prepare(
        `INSERT INTO resource_fts(provider, resource_id, title, author, description, tags, content)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        resource.ref.provider,
        resource.ref.id,
        resource.title,
        resource.author,
        resource.description,
        resource.tags.join(' '),
        resource.fullTextContent,
      );
    return {
      created: !existing,
      ref: resource.ref,
      bodyBytes: resource.bodyBytes,
      licenseSpdx: resource.licenseSpdx,
      reviewRequired: resource.reviewRequired,
    };
  }

  upsertResource(record) {
    const resource = normalizeRecord(record);
    const timestamp = now();
    return this.#transaction(() => this.#upsertNormalizedResource(resource, timestamp));
  }

  upsertResourceForProviderSync(provider, runToken, revision, record) {
    const normalizedProvider = limitedString(provider, 'Provider sync provider', 256);
    const normalizedToken = normalizeProviderSyncRunToken(runToken);
    const normalizedRevision = limitedString(revision, 'Provider sync revision', 4 * 1024);
    const resource = normalizeRecord(record);
    if (resource.ref.provider !== normalizedProvider) {
      throw new TypeError('Provider sync resource provider does not match the lease provider.');
    }
    const timestamp = now();
    return this.#transaction(() => {
      this.#assertAndRenewProviderSyncLease(normalizedProvider, normalizedToken, normalizedRevision);
      return this.#upsertNormalizedResource(resource, timestamp);
    });
  }

  getResource(ref) {
    this.#assertOpen();
    const normalizedRef = normalizeRef(ref);
    const row = this.db
      .prepare('SELECT * FROM resources WHERE provider = ? AND resource_id = ?')
      .get(normalizedRef.provider, normalizedRef.id);
    if (!row) {
      return null;
    }
    const blobs = this.db
      .prepare(
        `SELECT role, mime_type, body_gzip, body_bytes, body_encoding
         FROM resource_blobs
         WHERE provider = ? AND resource_id = ?
         ORDER BY role COLLATE NOCASE ASC, role ASC`,
      )
      .all(normalizedRef.provider, normalizedRef.id)
      .map(decodeBlob);
    return rowToResource(row, blobs);
  }

  search(query, options = {}) {
    this.#assertOpen();
    const match = ftsQuery(query);
    const settings = normalizeSearchOptions(options);
    const where = [];
    const parameters = [];
    if (settings.provider) {
      where.push('r.provider = ?');
      parameters.push(settings.provider);
    }
    if (settings.kind) {
      where.push('r.kind = ?');
      parameters.push(settings.kind);
    }
    let rows;
    if (match) {
      where.unshift('resource_fts MATCH ?');
      parameters.unshift(match);
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      rows = this.db
        .prepare(
          `SELECT r.*,
                  (SELECT COUNT(*) FROM resource_blobs AS b
                   WHERE b.provider = r.provider AND b.resource_id = r.resource_id) AS blob_count,
                  bm25(resource_fts) AS relevance
           FROM resource_fts
           JOIN resources AS r
             ON r.provider = resource_fts.provider AND r.resource_id = resource_fts.resource_id
           ${clause}
           ORDER BY relevance ASC, r.title COLLATE NOCASE ASC, r.provider ASC, r.resource_id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(...parameters, settings.limit, settings.offset);
    } else {
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      rows = this.db
        .prepare(
          `SELECT r.*,
                  (SELECT COUNT(*) FROM resource_blobs AS b
                   WHERE b.provider = r.provider AND b.resource_id = r.resource_id) AS blob_count
           FROM resources AS r
           ${clause}
           ORDER BY r.title COLLATE NOCASE ASC, r.provider ASC, r.resource_id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(...parameters, settings.limit, settings.offset);
    }
    return rows.map(rowToSummary);
  }

  getSyncState(provider) {
    this.#assertOpen();
    const normalizedProvider = limitedString(provider, 'Sync-state provider', 256);
    const row = this.db
      .prepare('SELECT state_json FROM provider_sync_state WHERE provider = ?')
      .get(normalizedProvider);
    if (!row) {
      return null;
    }
    const state = decodeJson(row.state_json, null);
    if (!isPlainObject(state)) {
      throw new Error(`Stored sync state for provider ${normalizedProvider} is invalid.`);
    }
    return { provider: normalizedProvider, ...state };
  }

  setSyncState(provider, state) {
    const normalized = normalizeSyncState(provider, state);
    return this.#transaction(() => this.#writeSyncState(normalized));
  }

  /**
   * Acquires one bounded maintenance run for a provider.  The opaque token is
   * intentionally an internal service capability and is never returned by an
   * MCP tool response or persisted in sync state.
   */
  claimProviderSyncRun(provider) {
    const normalizedProvider = limitedString(provider, 'Provider sync provider', 256);
    const runToken = randomUUID();
    return this.#transaction(() => {
      const nowMs = this.#currentSyncTimeMs();
      const existing = this.db
        .prepare('SELECT expires_at_ms FROM provider_sync_lease WHERE provider = ?')
        .get(normalizedProvider);
      if (existing && Number.isSafeInteger(Number(existing.expires_at_ms)) && Number(existing.expires_at_ms) > nowMs) {
        return { acquired: false };
      }
      const expiry = this.#claimableLeaseExpiry(nowMs);
      const timestamp = now();
      this.db
        .prepare(
          `INSERT INTO provider_sync_lease(provider, run_token, expires_at_ms, active_revision, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET
             run_token = excluded.run_token,
             expires_at_ms = excluded.expires_at_ms,
             active_revision = NULL,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
        )
        .run(normalizedProvider, runToken, expiry, timestamp, timestamp);
      return { acquired: true, runToken };
    });
  }

  releaseProviderSyncRun(provider, runToken) {
    const normalizedProvider = limitedString(provider, 'Provider sync provider', 256);
    const normalizedToken = normalizeProviderSyncRunToken(runToken);
    return this.#transaction(() => {
      const released = this.db
        .prepare('DELETE FROM provider_sync_lease WHERE provider = ? AND run_token = ?')
        .run(normalizedProvider, normalizedToken);
      return Number(released.changes) === 1;
    });
  }

  heartbeatProviderSyncRun(provider, runToken) {
    const normalizedProvider = limitedString(provider, 'Provider sync provider', 256);
    const normalizedToken = normalizeProviderSyncRunToken(runToken);
    return this.#transaction(() => {
      this.#assertAndRenewProviderSyncLease(normalizedProvider, normalizedToken);
      return true;
    });
  }

  setSyncStateForProviderSync(provider, runToken, state) {
    const normalized = normalizeSyncState(provider, state);
    const normalizedToken = normalizeProviderSyncRunToken(runToken);
    if (!normalized.state.revision) {
      throw new TypeError('Provider sync state requires a revision.');
    }
    return this.#transaction(() => {
      this.#assertAndRenewProviderSyncLease(normalized.provider, normalizedToken, normalized.state.revision);
      return this.#writeSyncState(normalized);
    });
  }

  /**
   * Commit a fully enumerated provider revision.  The eligible id list is
   * consumed only here, after every record in that revision has been stored.
   * It is intentionally not exposed as a generic deletion/query primitive.
   */
  completeProviderSync(provider, runToken, state, eligibleResourceIds, reconciliationScope = null) {
    const normalized = normalizeSyncState(provider, state);
    const normalizedToken = normalizeProviderSyncRunToken(runToken);
    if (normalized.state.status !== 'complete') {
      throw new TypeError('Provider reconciliation requires a complete sync state.');
    }
    if (!normalized.state.revision) {
      throw new TypeError('Provider reconciliation requires a revision.');
    }
    const ids = normalizeEligibleResourceIds(eligibleResourceIds);
    const managedAcquisition = normalizeReconciliationScope(reconciliationScope);
    return this.#transaction(() => {
      this.#assertAndRenewProviderSyncLease(normalized.provider, normalizedToken, normalized.state.revision);
      this.db.prepare(`DELETE FROM ${RECONCILIATION_IDS_TABLE}`).run();
      const insertEligibleId = this.db.prepare(
        `INSERT INTO ${RECONCILIATION_IDS_TABLE}(resource_id) VALUES (?)`,
      );
      for (const id of ids) {
        insertEligibleId.run(id);
      }

      const resourceScope = managedAcquisition === null
        ? ''
        : ` AND json_extract(provenance_json, '$.acquisition') = ?`;
      const scopeParameters = managedAcquisition === null ? [] : [managedAcquisition];
      // FTS has no foreign key, so remove its old provider rows explicitly
      // before deleting the resource rows (whose blobs cascade by FK).
      this.db
        .prepare(
          `DELETE FROM resource_fts
           WHERE provider = ?
             AND resource_id IN (
               SELECT resource_id FROM resources
               WHERE provider = ?
                 AND resource_id NOT IN (SELECT resource_id FROM ${RECONCILIATION_IDS_TABLE})
                 ${resourceScope}
             )`,
        )
        .run(normalized.provider, normalized.provider, ...scopeParameters);
      const deletedResources = this.db
        .prepare(
          `DELETE FROM resources
           WHERE provider = ?
             AND resource_id NOT IN (SELECT resource_id FROM ${RECONCILIATION_IDS_TABLE})
             ${resourceScope}`,
        )
        .run(normalized.provider, ...scopeParameters);
      this.db.prepare(`DELETE FROM ${RECONCILIATION_IDS_TABLE}`).run();
      const completedState = this.#writeSyncState(normalized);
      const released = this.db
        .prepare('DELETE FROM provider_sync_lease WHERE provider = ? AND run_token = ?')
        .run(normalized.provider, normalizedToken);
      if (Number(released.changes) !== 1) {
        throw new ProviderSyncLeaseError();
      }
      return {
        ...completedState,
        removedResources: Number(deletedResources.changes),
      };
    });
  }
}
