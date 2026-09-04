# Federated Shader Sources to NetEase MCP

This plugin contains two local, dependency-free Node 24 stdio MCP servers. Both
use built-in Node facilities, including `node:sqlite`; install Node.js **24 or
newer** before starting either service.

| Server | Start command from plugin root | Purpose |
| --- | --- | --- |
| `shadertoy-netease` | `node ./mcp/src/mcp-server.mjs` | Backward-compatible Shadertoy official-API cache, search, source inventory and NetEase candidate ranking. |
| `shader-source-registry` | `node ./mcp/src/sources/source-mcp-server.mjs` | Source-policy registry for URL resolution, provenance-aware local records, authorized source analysis and bounded compliant indexing. |

Do not start a stdio MCP through `npm start` or another lifecycle wrapper that
can write a banner to stdout. The server consumes and emits UTF-8 JSON-RPC,
one object per line; stdout is reserved for protocol data.

## Source-registry tools

| Tool | Use |
| --- | --- |
| `shader_source_registry_status` | Inspect registered providers, cache state and supported maintenance actions. |
| `resolve_shader_source_url` | Validate a user URL against the provider allowlist and return a canonical source reference without arbitrary fetching. |
| `search_shader_sources` | Search the local federated cache by text, provider or resource kind. |
| `get_shader_source_record` | Read a known provider/resource record and its provenance without assuming source is reusable. |
| `import_shader_link` | Register one authorized exact allowlisted link; the caller supplies an auditable authorization basis. |
| `sync_shader_source_step` | Perform one explicit bounded maintenance step: networked only for `isf`/`webgl-fundamentals`, or zero-network link-only seed for `book-of-shaders`. |
| `analyze_shader_source` | Perform conservative, provider-neutral static inventory of authorized source text. |

The accepted sources are Shadertoy, the official ISF library, twigl.app, The
Book of Shaders, ShaderFrog, Godot Shaders and WebGL Fundamentals. The service
does not crawl those sites. twigl user-work licenses are unknown. For an
explicit `ol=true&ss=<id>` share link, only caller authorization of
`user-owned`, `licensed`, or `author-permission` permits one bounded request to
the fixed experimental Firebase snapshot endpoint; `reference-only` and
`repository-license` stay zero-network and record only a link/metadata. The
service never enumerates twigl channels or directories. ShaderFrog remains a
manual `user-supplied-source-analysis` boundary and needs work-specific
permission/license review. A Godot Shaders canonical `/shader/<slug>/` link has
a two-stage per-work gate. `reference-only` and `repository-license` request
only that page and store page evidence/metadata; they never call
`/wp-json/shader_data/shader/<postId>` and cannot receive a final reusable-source
classification before the source header has been checked. Only `user-owned`,
`licensed`, or `author-permission` plus one supported, unambiguous license
(CC0, MIT, or GPLv3) scoped to the target article may request the fixed detail
endpoint. Source caching additionally requires exactly one matching supported
license in the leading source header. A missing, restrictive, composite, or
conflicting header blocks caching and remains `review_required`. The service
never crawls Godot directories or media. The Book of Shaders stays link-only: its offline
seed can index built-in original topic links but cannot fetch/cache chapter text.
Only official ISF and eligible official WebGL Fundamentals BSD course material
can be indexed through a networked automatic step.

`sync_shader_source_step` argument examples:

```json
{ "provider": "isf", "limit": 10 }
{ "provider": "webgl-fundamentals", "limit": 10 }
{ "provider": "book-of-shaders", "limit": 10 }
```

The first two may use the fixed official GitHub REST providers; the final form
only seeds link-only metadata locally and makes no network request.

## Existing Shadertoy tools

The original `shadertoy-netease` API stays available: `shadertoy_library_status`,
`search_shadertoy_library`, `get_shadertoy_project`,
`refresh_shadertoy_project`, `sync_shadertoy_catalog_step`,
`analyze_shadertoy_source`, and `rank_netease_candidates`.

Set an optional Shadertoy key only through the launched process environment:

```powershell
$env:SHADERTOY_API_KEY = 'your-key'
node src/mcp-server.mjs
```

Without it, the local registry and legacy local search/read/analysis continue
to work; legacy remote Shadertoy refresh/sync returns structured
`auth_required` results.

For explicit ISF or WebGL Fundamentals maintenance through the official GitHub
REST API, an optional `GITHUB_TOKEN` can raise GitHub's public-read rate limit.
Set it only in the launched process environment; the MCP never stores, returns
or logs the token. Without a token, eligible public reads remain possible under
GitHub's lower unauthenticated rate limit.

## Content and local storage

The service rejects arbitrary remote URLs, local paths and SQL. It does not
bypass login, robots, rate limits, user visibility or other access controls.
Use it only with content you are authorized to disclose to the connected
Codex/MCP client. Imported source, explicit source windows, analysis output and
SQLite cache content can enter that client context.

The legacy service uses `SHADERTOY_DATA_DIR` when explicitly set; otherwise it
uses `%CODEX_HOME%\data\shadertoy-netease`, then the user's Codex data
directory. The v0.2 registry uses `SHADER_SOURCE_DATA_DIR` first for its
separate `resources-v2.sqlite3`, then falls back to the legacy directory rule.
Keep data, cache sidecars and source exports outside the repository. Source is
not distributed by this plugin; preserve author, canonical URL, license evidence
and required attribution with every adaptation.
