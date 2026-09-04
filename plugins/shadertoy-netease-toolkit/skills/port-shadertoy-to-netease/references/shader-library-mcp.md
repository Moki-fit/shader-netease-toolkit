# Federated Shader Library and Source Registry MCP

The plugin ships two independent local MCP servers. A cached source record is
evidence about provenance and local availability, not proof of copyright
permission, a valid NetEase route or in-game compatibility.

## Source registry first

Use `shader-source-registry` for every non-empty URL before opening it in a
browser. Its provider allowlist and URL parser are a safety and licensing
boundary, not a convenience check.

| Need | Tool | Required interpretation |
| --- | --- | --- |
| See providers, cache state and allowed maintenance | `shader_source_registry_status` | Provider capability is not a permission grant. |
| Classify a supplied URL | `resolve_shader_source_url` | Use only its canonical URL/provider; unsupported URL means no arbitrary fetch. |
| Find locally indexed shaders or learning references | `search_shader_sources` | Search results may be metadata-only or link-only. |
| Inspect known provenance/license metadata | `get_shader_source_record` | Do not request/copy source unless its policy and authority permit it. |
| Register an exact authorized link | `import_shader_link` | The caller must supply an auditable authorization basis. |
| Do one approved maintenance step | `sync_shader_source_step` | Networked only for `isf`/`webgl-fundamentals`; `book-of-shaders` is a zero-network link-only seed. All forms are explicitly bounded. |
| Inventory authorized source text | `analyze_shader_source` | Conservative text analysis, not a compiler or target compatibility proof. |

Source policy details are in
[provider-source-policy.md](provider-source-policy.md).

## Retained Shadertoy library

The legacy `shadertoy-netease` server remains compatible:

| Need | Tool | Follow-up |
| --- | --- | --- |
| Diagnose library/authentication | `shadertoy_library_status` | Treat `auth_required` as a boundary. |
| Find similar Shadertoy effects | `search_shadertoy_library` | Compare only after target-route verification. |
| Rank known Shadertoy candidates | `rank_netease_candidates` | Score is a local heuristic, not approval. |
| Retrieve a known project | `get_shadertoy_project` | On miss, refresh only with usable authentication. |
| Retrieve an absent known project | `refresh_shadertoy_project` | Keep request to that project; do not expand to sync. |
| Inventory Shadertoy source | `analyze_shadertoy_source` | Prefer generic analysis for multi-provider workflows. |
| Bounded catalog maintenance | `sync_shadertoy_catalog_step` | Never make it an implicit porting action. |

When a Shadertoy remote action is explicitly requested, use only its official
Public + API path. Configure `SHADERTOY_API_KEY` in the MCP process environment,
never in an AddOn, Skill, artifact or source-control file. Respect current
account eligibility/quota and use a bounded operation; do not scrape projects
outside the official API surface.

## Fallbacks and evidence

If a server is unavailable, use a normal browser or user-provided source only
within the provider's stated boundary. Do not bypass login, rate limits, robots,
visibility, paywalls or other access controls. Report acquisition path (registry,
legacy library, browser or user-provided), canonical source URL, author when
known, license evidence and required attribution. If evidence is incomplete,
limit work to analysis, feasibility or independently written look-alike design.
