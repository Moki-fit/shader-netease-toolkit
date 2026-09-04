# Shadertoy Library MCP

Use the connected Shadertoy library as the first source for discovery and project retrieval. Treat its records as evidence about known projects; do not treat them as proof that a NetEase render route exists or as in-game validation.

## Choose a Tool

| Need | Tool | Follow-up |
| --- | --- | --- |
| Diagnose library availability or authentication | `shadertoy_library_status` | Treat `auth_required` as a boundary; use a fallback if credentials are unavailable. |
| Find an effect with similar visual behavior | `search_shadertoy_library` | Use `rank_netease_candidates` to prioritize candidates that fit the verified target route. |
| Rank already known candidates for a verified target route | `rank_netease_candidates` | Treat the score as a local heuristic; inspect the selected project before implementation. |
| Retrieve a known URL or project | `get_shadertoy_project` | On a miss, refresh only when status confirms usable authentication, then retrieve again. |
| Retrieve a known project absent from the local catalog | `refresh_shadertoy_project` | Keep the request limited to that project; do not turn it into a catalog sync. |
| Inspect retrieved or user-provided shader source | `analyze_shadertoy_source` | Treat findings as inventory, not GLSL compilation or target compatibility proof. |
| Improve a catalog under an explicit bounded request | `sync_shadertoy_catalog_step` | State the bound and stop at the step result. |

For a similar-effect request, search before browsing. For an exact URL, get before checking status or refreshing. If the MCP is unavailable, status is `auth_required`, or a refresh cannot be performed, use a normal browser or user-provided source instead.

Do not bypass login, API, rate-limit, robots, or other access controls. Configure `SHADERTOY_API_KEY` only in the MCP service environment; never place a key in an AddOn, Skill, output artifact, or source-control file.

## Catalog Scope

Keep `sync_shadertoy_catalog_step` as the only in-task synchronization action and bound it deliberately. Reserve a full catalog sync for an operator-controlled CLI operation, never an implicit action of a porting, analysis, or review request. If the user explicitly authorizes that operational work, use the deployment's current CLI full-sync workflow and help rather than preserving a command here.

Before an initial full sync, re-check the current account eligibility and quota on the official [Shadertoy API page](https://www.shadertoy.com/howto#q2). As verified on 2026-09-02, API keys require Silver or Gold status and API use is limited to 1500 requests per month. Treat a full sync as resumable, quota-aware catalog maintenance; never promise that every remote project will be fetched in one run. Only `Public + API` projects are in scope.

## License and Source Citation

Before copying or closely translating shader code, inspect the project and license status. Honor an explicit project license when one is declared. Only when no explicit license is declared should the Shadertoy default CC BY-NC-SA-3.0 be recorded. Any use of the Shadertoy API also requires Shadertoy API attribution.

In the delivery, identify the project URL or identifier, title and author when available, acquisition path (local library, refreshed API result, browser, or user-provided), license status, and required attribution. If source or license evidence is incomplete, limit the work to analysis, feasibility, or an independently written look-alike.
