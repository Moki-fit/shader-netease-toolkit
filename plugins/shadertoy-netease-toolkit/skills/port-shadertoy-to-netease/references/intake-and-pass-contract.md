# Intake and Source Effect Contract

Use this template before porting a non-trivial Shadertoy effect. Keep unknowns explicit.

## Request Scope

- Mode: read-only study / feasibility / prompt or specification / implementation / review
- Shadertoy URL:
- User-provided source location:
- Target AddOn absolute path:
- Target NetEase Minecraft version:
- Target devices and quality tiers:
- Intended route/context: scene / transition / UI / entity / block / particle / unknown
- Trigger, lifetime, stacking, and multiplayer behavior:
- Source license or adaptation authority:
- Approved degradation level:

## Source Completeness

| Item | Present | Provenance | Notes |
| --- | --- | --- | --- |
| Common | yes/no/n-a | URL/file/user | |
| Image | yes/no | URL/file/user | |
| Buffer A | yes/no/n-a | URL/file/user | |
| Buffer B | yes/no/n-a | URL/file/user | |
| Buffer C | yes/no/n-a | URL/file/user | |
| Buffer D | yes/no/n-a | URL/file/user | |
| Cubemap/Sound pass | yes/no/n-a | URL/file/user | |
| Channel assets | complete/partial/none | URL/file/user | |
| Visual reference | video/images/live page | | |

Do not mark the source complete merely because an Image pass was visible.

## Pass Graph

| Pass | Entry | iChannel0 | iChannel1 | iChannel2 | iChannel3 | Feedback/order |
| --- | --- | --- | --- | --- | --- | --- |
| Common | shared code | n-a | n-a | n-a | n-a | |
| Image | `mainImage`/`main` | | | | | final |
| Buffer A-D | | | | | | |

Describe cycles explicitly, for example `Buffer A[t] <- Buffer A[t-1]` or `Image <- Buffer A <- Buffer B`.

## Host Inputs and Assets

| Source input | Used by pass/line | Meaning | Required fidelity | Candidate target status |
| --- | --- | --- | --- | --- |
| `iResolution` | | viewport and aspect | exact/approximate | pending |
| `iTime` / `iTimeDelta` | | animation clock | | pending |
| `iFrame` / `iFrameRate` | | temporal state | | pending |
| `iMouse` | | pointer state | | pending |
| `iDate` | | wall clock | | pending |
| `iChannel0..3` | | texture/pass/audio/etc. | | pending |
| other | | | | pending |

For each channel, record type, dimensions, wrap/filter/mipmap assumptions, color space, and whether it is external media or another pass.

## Visual Behavior Contract

- Composition and spatial anchors:
- Coordinate and aspect convention:
- Motion phases, period, and synchronization:
- Palette, brightness range, and color-space assumption:
- Edge softness, antialiasing, glow, and alpha behavior:
- Interaction or input response:
- Features that make the effect recognizable:
- Features that may be approximated:

## Risk Inventory

- GLSL dialect/version features:
- Dynamic loops/indexing or costly iteration:
- Derivatives, explicit LOD, integer/bit operations, or sampler arrays:
- Feedback, history, video, keyboard, microphone/audio, or cubemap dependency:
- Division/domain/precision/NaN risks:
- License, attribution, or redistribution constraints:

## Readiness Decision

- Source contract: complete / incomplete
- Safe action now: study / original look-alike / feasibility only / implementation
- Blocking unknowns:
- User decisions still required:

An original look-alike must describe visual behavior independently and must not reconstruct unavailable third-party code.
