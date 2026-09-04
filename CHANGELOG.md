# Changelog

## 0.2.0 - 2026-09-04

- Upgrade the toolkit from a Shadertoy-only workflow to a source-policy-aware federated shader and graphics-learning toolkit.
- Add the `shader-source-registry` MCP server with source URL resolution, bounded local search, provenance records, authorized link import, constrained synchronization, and provider-neutral shader analysis.
- Add policy-aware support for ISF, twigl.app, The Book of Shaders, ShaderFrog, Godot Shaders, and WebGL Fundamentals while retaining every existing Shadertoy MCP tool and workflow.
- Limit networked automated synchronization to the official ISF library and official WebGL Fundamentals BSD lessons; allow only an offline, link-only Book of Shaders seed while prohibiting site-wide crawling and access-control bypasses.
- Require work-specific license evidence before source reuse: missing Shadertoy declarations remain review-required, and Godot source caching requires one matching scoped page license and leading source-header license.
- Reconcile removed ISF/WebGL records atomically only after a replacement revision completes, while preserving partial-sync resumability.
- Clarify that learning means on-demand retrieval, local indexing/caching, and analysis rather than model training or third-party content redistribution.

## 0.1.0 - 2026-09-04

- Package the `port-shadertoy-to-netease` Skill and local Node 24 MCP together.
- Add a repo marketplace manifest and portable relative MCP launch configuration.
- Include bounded official-API synchronization, local SQLite search, conservative source analysis, license provenance, and NetEase candidate ranking.
- Exclude API keys, cached shader databases, local Codex configuration, and third-party shader source from distribution.
