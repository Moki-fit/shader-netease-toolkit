# Security policy

## Content, cache and secrets

Only import or submit material that you are authorized to provide to Codex and
the connected MCP client. URL resolution and local search are deliberately
provider-allowlisted; the toolkit is not a general web downloader or crawler.
It rejects unsupported hosts, redirects and access-control bypasses rather than
trying to work around them.

Imported source, explicit source snippets, provider records and SQLite cache
entries can enter the local MCP process and the connected Codex context. Source
is omitted from normal reads where possible, but an explicit bounded source
window or analysis request can expose it to that client. Do not submit private,
paid, NDA-protected, credential-bearing or otherwise unauthorized works.

Keep cached databases, source exports and diagnostics outside the repository.
For example, export to `<outside-repository-path>\shader-review\` rather than
under the project checkout. Ensure repository ignore rules exclude local data,
database sidecars and exports before creating them.

Never commit or report a real `SHADERTOY_API_KEY`, GitHub token, cached SQLite
database, private shader source, local Codex configuration or exported third-
party material. Configure secrets only through the local process environment.

## Reporting

Report security issues through a private GitHub security advisory for this
repository. Do not open a public issue containing credentials, private source,
or reproduction data that belongs to another author.

## Supported version

Only the latest commit on the default branch is supported during the initial
`0.x` development period.
