# Shadertoy-to-NetEase MCP

This is a local, dependency-free Node 24 MCP server and CLI for a cached Shadertoy library plus conservative NetEase porting analysis. It uses the public Shadertoy API only; do not use it to bypass access controls or copy work without the author's applicable permission/license.

The server returns author, canonical source URL, license status, and `Shadertoy API` attribution with project reads. It does not accept arbitrary remote URLs, local paths, or SQL over MCP. Cached project source is omitted by default; a caller can request only one explicit, bounded pass window.

Set an API key only through the environment of the launched process:

```powershell
$env:SHADERTOY_API_KEY = 'your-key'
node src/mcp-server.mjs
```

Without that variable, local search/read/analysis continue to work and refresh/sync return structured `auth_required` results. Data uses `SHADERTOY_DATA_DIR` when explicitly set; otherwise it uses `%CODEX_HOME%\data\shadertoy-netease`, then `%USERPROFILE%\.codex\data\shadertoy-netease` (or `HOME`), then the current-directory fallback. The selected data directory is created automatically on first local request.

The stdio server consumes and emits one UTF-8 JSON-RPC object per line. Its stdout is reserved for protocol messages; operational logs use stderr. Start the MCP endpoint only with `node src/mcp-server.mjs`; do not use `npm start` or another npm lifecycle wrapper for stdio, because its banner output corrupts the protocol stream. Requests are capped at 8 MiB at the line-framing boundary (the submitted GLSL source remains separately capped at 2 MiB UTF-8), and complete JSON-RPC responses are capped at 1 MiB.

## Official API scope and maintenance expectations

As checked on 2026-09-02, Shadertoy states that Silver or Gold accounts can request an API key through [My Apps](https://www.shadertoy.com/myapps), and its [How-to/API guidance](https://www.shadertoy.com/howto) limits ordinary API access to 1,500 requests per month and shaders marked `Public + API`. This service uses only that official API surface and preserves the returned attribution/license metadata; it does not scrape private or non-API content.

`sync --full` is resumable, budgeted maintenance, not a promise that every remote record will finish in one invocation. It defaults to at most 100 logical catalog/detail operations per CLI run; `--max-operations N` sets a strict 1..1500 per-run ceiling. A non-resume full sync reserves one logical operation for the ID-only catalog listing, and each valid project-detail fetch reserves one more. `sync --full --resume` skips the catalog listing and spends its budget only on pending project-detail fetches.

`--limit` remains the project-fetch batch size, not the total operation budget. The CLI never starts a fetch batch larger than the remaining `--max-operations` budget. When pending work remains after the budget is exhausted, the JSON result is a structured `partial` / `operation_budget_exhausted` response with `progress.budget`, `progress.consumed`, `progress.remaining`, and `progress.resumable`; rerun with `sync --full --resume` and an explicit operation budget to continue.

This is a per-run logical-operation ceiling, not an HTTP-attempt or monthly-allowance meter. API-client retries and other use of the same API key can consume more official allowance than these counted catalog/detail operations. Operators must choose `--max-operations` based on their Shadertoy account's remaining API allowance. The local scheduler deliberately spaces calls conservatively; that local pacing is an implementation choice, not a claimed official per-second API allowance.

The CLI program itself writes JSON:

```powershell
npm test
node src/cli.mjs init
node src/cli.mjs status
node src/cli.mjs search "volumetric" --limit 10
node src/cli.mjs get Xds3zN
node src/cli.mjs get Xds3zN --include-source --pass-index 0 --source-offset 0 --max-chars 4096
node src/cli.mjs refresh Xds3zN
node src/cli.mjs sync --limit 10
node src/cli.mjs sync --full --limit 10 --max-operations 100
node src/cli.mjs sync --full --resume --limit 10 --max-operations 100
node src/cli.mjs import-json "$env:TEMP\catalog-export.json"
```

`sync --full` first refreshes the ID-only official catalog, then drains bounded project-fetch steps at no more than 0.5 API calls per second by default. If a full run is interrupted, reaches its logical-operation budget, or has pending records, `sync --full --resume` continues those local pending records without another catalog request. `import-json` is intentionally a CLI-only operation and requires an explicit local JSON file path outside the repository. Import only source that you are authorized to disclose to the connected MCP client; an explicit `include_source` request can return a bounded source window.
