---
name: port-shadertoy-to-netease
description: Analyze, port, review, or validate a Shadertoy or other supported GLSL/source-link effect for a NetEase Minecraft AddOn. Use when a request gives a Shadertoy, ISF, twigl, The Book of Shaders, ShaderFrog, Godot Shaders, or WebGL Fundamentals URL/source, asks for a similar effect, or asks to recreate a shader-style visual through a full-screen post-process, JSON UI shader, material, entity/block render path, particle effect, or transition. Do not use for arbitrary-site scraping or unlicensed source copying.
---

# Port Shadertoy to NetEase

Turn an authorized source effect or graphics-learning reference into a
source-backed NetEase Minecraft implementation plan, review, prompt, or narrow
code change. The `$port-shadertoy-to-netease` name is retained for compatibility;
the workflow now uses a federated source registry in addition to the existing
Shadertoy library.

“学习” means on-demand retrieval, bounded local indexing/caching and analysis.
It does not train a model and does not grant permission to redistribute a third-
party work. Do not crawl sites, evade access controls, reconstruct unavailable
source, or treat an unknown license as reusable.

## Source Discovery and Routing

Read [references/shader-library-mcp.md](references/shader-library-mcp.md) before
using either MCP. For a source-specific decision, also read
[references/provider-source-policy.md](references/provider-source-policy.md).

1. **A user supplies a URL:** call `resolve_shader_source_url` first. Use its
   provider, canonical URL, source/access mode and license policy; do not browse
   or fetch arbitrary URLs before this check. If it is unsupported, ask for an
   allowed direct source export or restrict the response to general learning.
2. **A user wants a similar effect:** search the federated cache with
   `search_shader_sources`, then use the retained `search_shadertoy_library`
   when a Shadertoy candidate is relevant. Rank retrieved Shadertoy candidates
   with `rank_netease_candidates` only after the target render route is known.
3. **An exact record is known:** use `get_shader_source_record`; for legacy
   Shadertoy records use `get_shadertoy_project`. Do not imply a cached record
   proves source permission or an available NetEase entry.
4. **Authorized source is available:** use the provider-neutral
   `analyze_shader_source`. Keep `analyze_shadertoy_source` as a compatible
   Shadertoy-specific fallback. Both are conservative inventory, not GLSL
   compilation or in-game proof.
5. **Maintenance is explicitly requested:** use `sync_shader_source_step` for
   a networked, explicitly bounded `provider: "isf"` or
   `provider: "webgl-fundamentals"` step, or for the zero-network,
   link-only `provider: "book-of-shaders"` seed. Never use it as an implicit
   porting step. Use the existing
   `sync_shadertoy_catalog_step` only for explicitly bounded, authenticated
   Shadertoy maintenance.

`twigl` user-work licenses are unknown. An explicit `ol=true&ss=<id>` share
link may use one bounded request to the fixed experimental Firebase snapshot
endpoint only when the caller's basis is `user-owned`, `licensed`, or
`author-permission`; `reference-only` and `repository-license` remain
zero-network link/metadata records. Never enumerate twigl channels or
directories. `ShaderFrog` remains a user-supplied-source-analysis path: a link
is only a work-specific reference, so ask the user to provide an authorized
export/source and verify its individual license. `Godot Shaders` is a narrow
two-stage per-work exception. With `reference-only` or `repository-license`,
request only the canonical `/shader/<slug>/` page and record page evidence /
metadata; never call its detail API or make a final reusable-source
classification before a source header is checked. Only `user-owned`, `licensed`,
or `author-permission` **and** one unambiguous supported page license (CC0, MIT,
or GPLv3) permit the fixed `/wp-json/shader_data/shader/<postId>` request. Cross-
check that response's strong source-header license against page evidence; a conflict
blocks source caching and is `review_required`. Never crawl Godot directories or
media. The Book of Shaders is
link-only; its offline seed may register built-in original topic links, but never
cache/copy a chapter page. Extract ideas in original words and cite the chapter.
Use only the official ISF standard library and eligible official WebGL
Fundamentals BSD lessons for networked automatic indexing.

If either MCP is missing, use a normal browser and user-provided content as
fallbacks within the same provider/permission boundary. Never work around
authentication, rate limit, robots, visibility or platform restrictions.

## Companion Skills and Their Boundaries

This plugin does **not** bundle these companion Skills. They must be present in
the environment separately; absence lowers what can be claimed rather than
authorizing guesswork.

- Use `glsl-fundamentals` for every shader port or shader review. Add
  `glsl-coordinates`, `glsl-math`, `glsl-color`, `glsl-noise` or `glsl-sdf` only
  when the effect materially needs them.
- Use `mc-search` first and `netease-docs` second to verify NetEase APIs,
  manifests, shader/material entries, uniforms, resource formats and target
  version facts. Without them, label those facts unverified.
- When editing JSON UI or a UI `.fragment`/`.vertex` under `shaders/glsl`, use
  `netease-mc-ui-skill`. Start from the actual shared entry and preserve the
  original non-target fallback.
- When implementation changes `behavior_pack_*/**/*.py`, use both
  `mod-workflow` and `netease-python-addon-rules`; inspect architecture/imports,
  keep Python 2.7 compatibility and respect client/server boundaries and the
  project's actual framework.
- Use `mcdk-game-test-workflow` for NetEase game testing. Static analysis,
  source inventory and a screenshot are not MCDK or in-game acceptance.
- Use `multi-agent-orchestration` for complex independent research,
  implementation and review work.

## Workflow

### 1. Establish Scope, Authority and Source Contract

Determine whether the request is study, feasibility, prompt/specification,
review or AddOn implementation. Only an implementation request authorizes
writing the confirmed target AddOn. The references under this installed Skill
are templates, not user-project files; do not edit them during a port.

Collect the exact source URL or authorized export, complete pass/channel graph,
source authority/license evidence, target AddOn absolute path, intended visual
scope, target NetEase version, target devices and acceptable visual degradation.
For non-trivial source effects or knowledge-backed designs, use
[references/intake-and-pass-contract.md](references/intake-and-pass-contract.md).

Record author, canonical URL, acquisition path, license evidence and required
attribution. A platform's own license does not automatically license user works.
If source, assets, authority or license is incomplete, stop at analysis,
feasibility, prompt/specification or an independently authored look-alike.

### 2. Inventory the Effect

Run `analyze_shader_source` on the authorized source before translating it.
Record pass order, feedback, channel bindings, coordinate/aspect convention,
time/frame/mouse/audio inputs, output alpha/color space, numerical hot spots and
features that cannot be silently flattened (feedback, video, keyboard, audio,
cubemaps, derivatives, dynamic indexing or expensive loops).

When the user asks only for a similar effect, reproduce visual behavior rather
than source: composition, repetition, motion phases, palette, edge treatment
and interaction.

### 3. Prove the Target Render Entry

Inspect the actual AddOn before choosing a file or API. Trace manifests, pack
dependencies, resource references, materials, render controllers, UI definitions
and existing post-process/custom-renderer paths. Do not assume that an arbitrary
`.fragment`, `mainImage`, or invented JSON property is loaded by NetEase.

Choose the evidence-backed route:

| Desired scope | Candidate route to verify in the project |
| --- | --- |
| Whole scene or camera transition | Existing supported full-screen/post-process chain |
| HUD, panel, mask or menu effect | Actual JSON UI/shared UI shader entry |
| Entity, wearable, block or model surface | Existing material, render-controller, texture and geometry chain |
| Local particles/spatial accent | Supported particle/material route, possibly client-state driven |
| Missing renderer capability | Original approximation or explicit infeasibility report |

Use [references/target-entry-and-fallback-contract.md](references/target-entry-and-fallback-contract.md).
Every source input needs a verified target mapping, deliberate substitute or
explicit unsupported status before implementation.

### 4. Adapt Behavior to the Host Contract

Map `mainImage`, `fragCoord`, resolution, time, frame, mouse and channel inputs
only to inputs supplied by the verified host. Rebuild aspect-correct coordinates
from the real viewport/control geometry, select the actual GLSL/GLSL ES dialect,
and deliberately replace unsupported calls, outputs, arrays, loops or precision
assumptions. Preserve supported multi-pass order/feedback; otherwise state the
approved visual loss.

Keep host-required macros, includes, uniforms, sampling, alpha/compositing,
fog/depth, render order and non-target fallback. Guard denominators/domains and
review reverse-edge `smoothstep`, normalization, derivatives, NaN/Inf paths,
high iteration counts and mobile precision.

### 5. Implement Narrowly and Verify in Layers

Change only the confirmed entry and directly required resources. Preserve
unrelated controls, passes, materials, manifests and pack relationships. Keep
diagnostics, previews, source exports, caches and backups outside the upload
root.

Use [references/verification-matrix.md](references/verification-matrix.md) and
report separately:

1. Source inventory and authority/license status.
2. Static target checks: JSON, reference closure, linkage and host-contract
   preservation; compiler checks only if actually run.
3. MCDK/in-game checks: entry, timing, fallback, resize/lifecycle/errors and
   multiplayer isolation where relevant.
4. Target-device checks: visual match, compositing, FPS/frame pacing, heat,
   memory, touch/UI behavior and low-end fallback.

Missing MCDK or device evidence blocks claims that the effect runs, matches or
performs correctly. Mark those layers `not run` or `blocked`, even when the
static implementation is otherwise complete.

## Delivery Contract

State source provenance/attribution, license decision, chosen real render route,
source-to-target input mappings, approximations, changed files, tunable
parameters, rollback/fallback behavior, plus the four separate verification
results. Label every unverified platform fact and visual-performance claim.
