# Target Entry and Fallback Contract

Fill this from the target AddOn and verified documentation. Do not use remembered or invented NetEase fields as evidence.

## Project Identity

- AddOn absolute path:
- Behavior pack(s):
- Resource pack(s):
- Manifest versions and dependencies:
- NetEase/Minecraft target version:
- Existing framework: native / QuModLibs / Nekans / other
- Architecture and import/reference inspection performed:

## Proven Render Entry

- Desired visual scope:
- Chosen route: scene post-process / JSON UI shader / material-render controller / particle / other
- Entry file and identifier:
- Files that reference the entry:
- Runtime component that enables or supplies it:
- Evidence source: project path / `mc-search` result / NetEase docs
- Target shader dialect and stage:
- Known platform/device restrictions:

If no closed reference chain reaches the shader or material, the entry is not proven.

## Source-to-Target Mapping

| Source contract | Verified target input or implementation | Evidence | Exact/approximated/unsupported |
| --- | --- | --- | --- |
| fragment coordinate | | | |
| resolution/aspect | | | |
| time/delta/frame | | | |
| pointer or interaction | | | |
| channel 0 | | | |
| channel 1 | | | |
| channel 2 | | | |
| channel 3 | | | |
| pass history/feedback | | | |
| output color/alpha | | | |

Do not map a source uniform to a name that merely looks plausible. Confirm how the selected host supplies it.

## Host Invariants to Preserve

- `__multiversion__`, version declaration, precision, and required macros:
- Includes and declarations:
- Vertex-to-fragment varyings:
- Existing samplers and texture semantics:
- Fragment outputs, alpha, blending, premultiplication, and discard:
- Fog, depth, lighting, and color-transfer behavior:
- Render/process order:
- Existing UI controls/materials/passes that must remain unchanged:
- Non-target devices or modes that require the original path:

Capture before/after evidence for each invariant that the change touches.

## Enable, Disable, and Lifecycle

- Default state:
- Trigger and duration:
- Re-entry/stacking rules:
- Disable path:
- Original fallback path:
- Resize/aspect changes:
- World leave, UI close, death/respawn, disconnect, and reload cleanup:
- Multiplayer scope and client/server authority:

If Python is required, use the project's actual framework and the mandatory NetEase Python skills before editing.

## Degradation Plan

| Missing or expensive feature | Proposed substitute | Visual loss | Devices/quality tier | User approved |
| --- | --- | --- | --- | --- |
| multi-pass/feedback | | | | |
| external channel | | | | |
| expensive loop/noise | | | | |
| unsupported interaction | | | | |
| precision/derivative issue | | | | |

Never flatten a pass graph or remove an input without recording the consequence.

## Implementation Gate

Implementation may proceed only when:

- the entry is reached by a real project reference chain;
- every required source input is exact, deliberately approximated, or explicitly unsupported;
- host invariants and the fallback path are written down;
- source/license status permits the intended action;
- any behavior-pack Python edit has its architecture/import analysis and required skills active.

Otherwise deliver a feasibility report or request the missing evidence.
