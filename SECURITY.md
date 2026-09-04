# Security policy

## Secrets

Never commit or report a real `SHADERTOY_API_KEY`, GitHub token, cached SQLite
database, or private shader source. Configure secrets only through the local
process environment.

Only use `import-json` for source that you are authorized to provide to the
connected Codex/MCP client. Source is omitted by default, but an explicit
`include_source` request can return a bounded source window to that client.

## Reporting

Report security issues through a private GitHub security advisory for this
repository. Do not open a public issue containing credentials, private source,
or reproduction data that belongs to another author.

## Supported version

Only the latest commit on the default branch is supported during the initial
`0.x` development period.
