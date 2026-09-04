---
name: port-shadertoy-to-netease
description: Analyze, port, review, or validate a Shadertoy shader or similar GLSL effect for a NetEase Minecraft AddOn. Use when a request includes a Shadertoy URL or source, Common/Image/Buffer passes, iChannel assets, or asks to reproduce a Shadertoy-style visual in 网易我的世界 through a full-screen post-process, JSON UI shader, material, entity or block render path, particle effect, or transition. Prefer a connected local Shadertoy library for discovery and source retrieval, with browser and user-source fallback.
---

# Port Shadertoy to NetEase

Turn a Shadertoy effect into a source-backed, project-specific NetEase Minecraft implementation plan or code change. Treat this skill as the orchestration and acceptance layer: determine the real render route, preserve the host contract, route factual checks to the existing NetEase and GLSL skills, and separate static evidence from in-game evidence.

Prefer a connected Shadertoy library MCP for discovery and project retrieval. Keep a normal browser and user-provided source as fallbacks when it is unavailable or cannot authenticate. Never circumvent access controls.

## Discover Source with the Shadertoy Library

Read [references/shader-library-mcp.md](references/shader-library-mcp.md) before using the library tools.

- For a request for a similar effect, query `search_shadertoy_library` first, then use `rank_netease_candidates` to compare the viable results against the verified target route.
- For a Shadertoy URL or project identifier, call `get_shadertoy_project` first. On a cache miss, inspect `shadertoy_library_status`; only call `refresh_shadertoy_project` when usable authentication is available, then retrieve the project again.
- If the status is `auth_required`, the MCP is unavailable, or refresh cannot run, use the normal browser or user-provided source. Do not evade login, API, rate-limit, or other access controls.
- Use `analyze_shadertoy_source` to inventory available source. Use the bundled `scripts/analyze_shadertoy_source.py` as the offline/local fallback; both are conservative analysis, not compilation.
- Use `sync_shadertoy_catalog_step` only for an explicitly bounded catalog action. Never start an unbounded full-site sync from an implicit porting task.

## Route Companion Skills

- Use `glsl-fundamentals` for every shader port or shader review.
- Use `glsl-coordinates`, `glsl-math`, `glsl-color`, `glsl-noise`, or `glsl-sdf` only when that topic is materially involved.
- Use `mc-search` first and `netease-docs` second for NetEase APIs, events, fields, manifests, materials, shader entries, uniforms, or resource formats. Mark anything not verified against the target version as unverified; do not invent it.
- Use `netease-mc-ui-skill` when editing JSON UI or a UI shader under `shaders/glsl`. Start from the actual shared entry and preserve the original non-target fallback.
- If implementation edits `behavior_pack_*/**/*.py`, use both `mod-workflow` and `netease-python-addon-rules`. Inspect architecture and imports first, keep Python 2.7 compatibility, respect client/server boundaries, and follow the project's existing QuModLibs, Nekans, or native architecture.
- Use `mcdk-game-test-workflow` for NetEase game testing. Never label a static check, standalone GLSL check, or screenshot as MCDK or in-game acceptance.
- For complex work with independent research, implementation, and review tracks, use `multi-agent-orchestration`.

## Workflow

### 1. Establish Scope and Source Authority

Determine whether the user wants read-only study, a feasibility report, a prompt/specification, a review, or implementation in an AddOn. Treat study, feasibility, prompt/specification, and review requests as read-only unless the user explicitly authorizes project changes. Only an implementation request authorizes writing the target AddOn within the confirmed scope.

The files under `references/` are read-only templates. For read-only requests, use their fields only in the response or in-memory reasoning; do not create working files. During an authorized implementation, keep any necessary diagnostics or working notes outside the AddOn upload root. Never fill the templates by editing the installed global Skill during a port.

Collect or locate:

- the Shadertoy URL and the complete Common, Image, and Buffer/Cubemap/Sound sources that affect the image;
- every `iChannel` asset or pass binding and any feedback relationship;
- the target AddOn absolute path, intended screen or world context, trigger/lifetime, target NetEase version, and target devices;
- the source license or the user's authority to adapt it, plus source provenance and required attribution;
- visual references for timing, palette, framing, alpha, and acceptable degradation.

Use the library workflow above, a supported browser, or user-provided source. Before copying source, confirm the library/license status. Honor an explicit project license when one is declared; only when no explicit license is declared should the Shadertoy default CC BY-NC-SA-3.0 be recorded. Any use of the Shadertoy API also requires Shadertoy API attribution. Do not bypass access controls, reconstruct unavailable author code, or assume a URL exposes all passes. If source, assets, or license status is incomplete, identify exactly what is missing and limit the result to analysis or an original look-alike design.

Read [references/intake-and-pass-contract.md](references/intake-and-pass-contract.md) and answer its relevant fields for non-trivial effects.

### 2. Build the Source Effect Contract

Run `analyze_shadertoy_source` or, when working offline, `scripts/analyze_shadertoy_source.py` on the available shader files as an early inventory. Leave `--target unknown` until the actual entry dialect is proven, then select `gles100` or `gles300` deliberately. Treat its findings as conservative text analysis, not compilation or compatibility proof.

Record:

- pass graph, pass order, self-feedback/cyclic feedback, channel types, and missing dependencies;
- `mainImage`/`main`, coordinate conventions, resolution/aspect assumptions, time/frame/mouse/date/audio inputs, and texture sampling;
- output alpha, color range/color-space assumptions, visual invariants, and numerical hot spots;
- features that cannot be silently flattened, including feedback buffers, video, keyboard, audio, cubemaps, derivatives, dynamic indexing, or expensive loops.

When only a similar effect is requested, extract the visual behavior rather than copying the original implementation: composition, repetition, motion phases, palette, edge treatment, and interaction.

### 3. Prove the Target Render Entry

Inspect the actual project before choosing a file or API. Trace manifests, pack dependencies, resource references, material/shader configuration, render controllers, UI definitions, and any existing post-process or custom renderer. For an unknown NetEase Python project, establish its architecture before edits; for an existing Python module, inspect its import/reference chain.

Do not assume that an arbitrary `.fragment` file, a Shadertoy `mainImage`, or an invented JSON `shader` property will be loaded by NetEase Minecraft.

Choose the route from evidence:

| Desired scope | Candidate route to verify in the project |
| --- | --- |
| Whole scene or camera transition | Existing supported full-screen/post-process chain |
| HUD, panel, mask, or menu-only effect | Actual JSON UI/shared UI shader entry |
| Entity, wearable, block, or model surface | Existing material, render-controller, texture, and geometry chain |
| Local particles or spatial accents | Supported particle/material path, possibly driven by client state |
| Renderer capability absent from the target version | Original approximation or explicit infeasibility report |

Use [references/target-entry-and-fallback-contract.md](references/target-entry-and-fallback-contract.md) to record the decision. Implementation is not ready until each source input has a verified target mapping, a deliberate substitute, or an explicit unsupported status.

### 4. Adapt to the Host Contract

Translate behavior, not just syntax:

- map `mainImage`, `fragCoord`, `iResolution`, `iTime`, `iFrame`, `iMouse`, and `iChannel*` only to inputs actually supplied by the chosen host;
- reconstruct aspect-correct coordinates from the verified viewport or control geometry;
- select the real GLSL/GLSL ES dialect and replace unsupported constructors, array operations, texture calls, outputs, loop forms, or precision assumptions deliberately;
- keep multi-pass order and feedback when the host can support them; otherwise propose an explicit approximation and describe the visual loss;
- guard denominators and domains and review reverse-edge `smoothstep`, normalization, derivatives, NaN/Inf paths, high iteration counts, and mobile precision;
- preserve host-required `__multiversion__`, includes, macros, uniforms, texture sampling, alpha/compositing, fog/depth behavior, color transfer, render order, and non-target fallback.

Never overwrite a working global/UI/post-process route merely to insert the new effect. Add the smallest compatible branch and retain the original path when the effect is disabled or unsupported.

### 5. Implement Narrowly

Change only the confirmed entry and its directly required resources. Preserve unrelated controls, passes, materials, manifests, and pack relationships. Keep generated diagnostics, previews, caches, and backups outside the upload root.

If Python controls effect state, use client-side rendering APIs only where verified, keep authoritative gameplay on the server, clean up state on unload/disconnect, and use the project's established communication/framework conventions.

### 6. Verify in Layers

Use [references/verification-matrix.md](references/verification-matrix.md) as the acceptance record.

1. **Source inventory:** analyzer findings, complete pass/channel inputs, and license status.
2. **Static target checks:** JSON parsing, reference closure, expected entry linkage, preservation of host contracts, and a real dialect compiler when one is available.
3. **MCDK/in-game checks:** effect entry, timing, enable/disable fallback, resize/aspect, world/UI lifecycle, errors, and multiplayer isolation where relevant.
4. **Target-device checks:** visual similarity, alpha/compositing, FPS, frame pacing, heat, memory, touch/UI behavior, and low-end fallback.

Report each layer separately as passed, failed, blocked, or not run. A successful analyzer run means only that its rules completed.

## Stop Rules

Stop short of implementation and report the blocker when:

- the required author source or channel assets are unavailable and faithful adaptation depends on them;
- license/permission does not allow copying and the user has not accepted an original reimplementation;
- the target AddOn or its real render entry cannot be inspected;
- the requested inputs or pass topology are unavailable on the verified NetEase route and no degradation has been approved.

Missing MCDK or target-device evidence does not block an otherwise authorized static implementation. It blocks only claims that the effect runs correctly, is deployed successfully, matches visually, or meets device performance requirements; mark those validation layers `not run` or `blocked`.

## Delivery Contract

State the source provenance and required attribution, chosen render route and why it is real for this project, source-to-target input mappings, deliberate approximations, files changed, tunable parameters, fallback/rollback behavior, and the four distinct results: source inventory, static target checks, MCDK/in-game, and target-device. Label every unverified platform fact or visual claim explicitly.
