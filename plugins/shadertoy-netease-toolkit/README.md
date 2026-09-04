# Federated Shader Sources to NetEase Toolkit plugin

This plugin keeps the `$port-shadertoy-to-netease` Skill name and existing
Shadertoy workflow, then adds a policy-aware source registry for shader works
and graphics-learning material. It does not bundle third-party shader source,
course content, API keys, or local databases.

The plugin starts two local Node 24 stdio services:

- `shadertoy-netease`: backward-compatible official Shadertoy cache, search,
  source inventory and NetEase candidate-ranking service.
- `shader-source-registry`: source URL resolver, provenance-aware local index,
  approved ISF/WebGL network maintenance, offline Book of Shaders link seeding,
  and provider-neutral source analyzer.

Supported providers are Shadertoy, the official ISF standard library,
twigl.app, The Book of Shaders, ShaderFrog, Godot Shaders, and WebGL
Fundamentals. Each provider has its own access, cache and license boundary; the
registry is not a full-site crawler and never bypasses access controls.

twigl user works remain license-unknown. A resolved `ol=true&ss=<id>` share link
may make one bounded request to its fixed experimental Firebase snapshot endpoint
only when the caller states `user-owned`, `licensed`, or `author-permission`.
`reference-only` and `repository-license` requests stay zero-network and record
only link/metadata; the registry never enumerates twigl channels or directories.
ShaderFrog remains a user-supplied-source-analysis path, not an editor-project
fetcher.

Godot Shaders has a two-stage per-work rule. `reference-only` and
`repository-license` request only the canonical page and store page evidence /
metadata; they never call the shader-detail API or give a final reusable-source
classification before a source header is checked. Only `user-owned`, `licensed`,
or `author-permission` with one supported license (CC0, MIT, or GPLv3) scoped to
the target article may fetch the fixed detail endpoint. Caching additionally
requires exactly one matching supported license in the leading source header;
a missing, restrictive, composite, or conflicting header blocks caching and
remains `review_required`. No directories or media are
crawled.

Use `SHADER_SOURCE_DATA_DIR` to put the v0.2 registry's independent local data
outside the repository; it falls back to `SHADERTOY_DATA_DIR` and the existing
Codex data-directory rule when unset.

See the repository-level README for installation, companion Skill dependencies,
API-key handling, source policies, attribution and NetEase verification rules.
