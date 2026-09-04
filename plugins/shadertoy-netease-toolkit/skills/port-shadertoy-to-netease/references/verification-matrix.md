# Verification Matrix

Keep four evidence layers separate. Use `passed`, `failed`, `blocked`, or `not run`; never promote a lower layer into a higher one.

## Layer 1: Source Inventory

| Check | Result | Evidence |
| --- | --- | --- |
| Required passes collected | | |
| `iChannel` bindings/assets collected | | |
| Feedback/pass order documented | | |
| Host inputs inventoried | | |
| License/adaptation authority recorded | | |
| Static analyzer completed | | command and findings |

The analyzer is a conservative pattern scanner. Zero findings do not prove valid GLSL, NetEase compatibility, or visual correctness.

## Layer 2: Static Target Validation

| Check | Result | Evidence |
| --- | --- | --- |
| JSON files parse strictly | | |
| Manifest/resource/material references close | | |
| Proven render entry still reaches target shader | | |
| Original non-target fallback remains reachable | | |
| Required host macros/includes/uniforms preserved | | |
| Alpha/depth/fog/color behavior reviewed | | |
| Target GLSL dialect compiled with a real compiler | | compiler/version/log |
| Python 2.7/import checks, if applicable | | |

If no suitable compiler exists, mark compilation `not run`; do not replace it with text scanning.

## Layer 3: MCDK or In-Game Validation

Use `mcdk-game-test-workflow` and preserve structured results/logs.

| Check | Result | Evidence |
| --- | --- | --- |
| Pack loads without new content/log errors | | |
| Correct entry and trigger activate the effect | | |
| Disable path restores the original image | | |
| Timing and animation remain stable | | |
| Resize/aspect/UI scale cases are correct | | |
| World/UI lifecycle cleanup is correct | | |
| Multiplayer/local-player scope is correct | | |
| Reload/reconnect does not leak state | | |

Static output or an external shader preview is not in-game evidence.

## Layer 4: Target-Device Acceptance

| Device/quality tier | Visual match | FPS/frame pacing | Heat/memory | Alpha/UI/touch | Fallback | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| PC target | | | | | | |
| Android target | | | | | | |
| iOS target | | | | | | |
| Low-end tier | | | | | | |

Compare against the agreed visual behavior contract rather than only a single screenshot. Include motion period, aspect ratios, bright/dark backgrounds, and repeated enable/disable.

## Required Delivery Summary

```text
Chosen render route:
Source inventory: passed/failed/blocked/not run
Static validation: passed/failed/blocked/not run
MCDK/in-game validation: passed/failed/blocked/not run
Target-device validation: passed/failed/blocked/not run
Known approximations:
Unverified claims:
Files changed:
Fallback/rollback:
Next runtime step:
```

Only claim deployment success in a target AddOn after the relevant runtime layer passes. A globally installed Skill itself must be discovered and invoked from a new Codex task; files existing on disk prove installation, not fresh-session callability.
