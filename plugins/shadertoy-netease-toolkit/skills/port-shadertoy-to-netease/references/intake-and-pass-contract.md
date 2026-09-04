# Intake and Source Effect Contract

Use this template before porting a non-trivial effect from any supported source
provider. Keep unknowns explicit. Complete the common contract first, then only
the provider-specific inventory that applies; `n-a` is different from unknown.
This intake does not prove a NetEase render entry or replace the separate target
entry and verification contracts.

## Request Scope and Source Authority

- Mode: read-only study / feasibility / prompt or specification / implementation / review
- Provider ID:
- Resource kind: shader / shader project / knowledge reference
- Original user URL or source reference:
- Canonical URL:
- Provider record reference, if available:
- Acquisition path: registry / legacy library / user export / browser / other
- Author, publisher, or work owner:
- Authorization basis: user-owned / licensed / author-permission / repository-license / reference-only / unknown
- License evidence: exact declaration, URL, header, page text, or unknown
- Required attribution, notice, copyleft, or redistribution constraints:
- User-provided source location, if authorized:
- Target AddOn absolute path:
- Target NetEase Minecraft version:
- Target devices and quality tiers:
- Intended route/context: scene / transition / UI / entity / block / particle / unknown
- Trigger, lifetime, stacking, and multiplayer behavior:
- Approved degradation level:

Do not treat a platform or repository license as an individual user-work license
unless the provider policy explicitly says it applies. A link-only/reference-only
record is not source authority.

## Common Source Completeness

| Item | Present | Provenance | License/authority status | Notes |
| --- | --- | --- | --- | --- |
| Canonical source/reference | yes/no | URL/record/user | | |
| Author/publisher evidence | yes/no/unknown | page/header/user | | |
| License evidence | explicit/partial/none/conflict | page/header/user | | |
| Required attribution/notice | yes/no/unknown | page/header/policy | | |
| Source text or authorized export | complete/partial/none/link-only | URL/file/user | | |
| Required external assets | complete/partial/none/n-a | URL/file/user | | |
| Visual reference | video/images/live page/none | | | |

Do not mark a source complete merely because one visible shader, preview, or
final-image pass was available. For a knowledge source, `link-only` remains
complete only for a learning/reference task, not for copying source code.

## Provider-specific Inventory

Complete the applicable subsection. Preserve its source-specific host contract
instead of flattening it into generic GLSL names.

### Shadertoy

#### Pass/source completeness

| Item | Present | Provenance | Notes |
| --- | --- | --- | --- |
| Common | yes/no/n-a | URL/file/user | |
| Image | yes/no | URL/file/user | |
| Buffer A | yes/no/n-a | URL/file/user | |
| Buffer B | yes/no/n-a | URL/file/user | |
| Buffer C | yes/no/n-a | URL/file/user | |
| Buffer D | yes/no/n-a | URL/file/user | |
| Cubemap/Sound pass | yes/no/n-a | URL/file/user | |
| `iChannel` assets | complete/partial/none | URL/file/user | |

#### Pass graph

| Pass | Entry | iChannel0 | iChannel1 | iChannel2 | iChannel3 | Feedback/order |
| --- | --- | --- | --- | --- | --- | --- |
| Common | shared code | n-a | n-a | n-a | n-a | |
| Image | `mainImage`/`main` | | | | | final |
| Buffer A-D | | | | | | |

Describe cycles explicitly, for example `Buffer A[t] <- Buffer A[t-1]` or
`Image <- Buffer A <- Buffer B`.

#### Host inputs and assets

| Source input | Used by pass/line | Meaning | Required fidelity | Candidate target status |
| --- | --- | --- | --- | --- |
| `iResolution` | | viewport and aspect | exact/approximate | pending |
| `iTime` / `iTimeDelta` | | animation clock | | pending |
| `iFrame` / `iFrameRate` | | temporal state | | pending |
| `iMouse` | | pointer state | | pending |
| `iDate` | | wall clock | | pending |
| `iChannel0..3` | | texture/pass/audio/etc. | | pending |
| other | | | | pending |

For each channel, record type, dimensions, wrap/filter/mipmap assumptions,
color space, and whether it is external media or another pass.

### ISF

| ISF contract item | Present/value | Target implication | Notes |
| --- | --- | --- | --- |
| ISF metadata/header | yes/no | host parser/version | |
| `INPUTS` names, types, defaults, ranges | | uniform/control mapping | |
| `PASSES` order and target sizes | | multi-pass route | |
| `PERSISTENT` buffers | | feedback/history requirement | |
| `IMPORTED` assets | | asset provenance and mapping | |
| ISF helper variables/functions | | host compatibility | |

### twigl

| twigl contract item | Present/value | Target implication | Notes |
| --- | --- | --- | --- |
| Mode `0..11` | | output/MRT expectation | |
| MRT or backbuffer behavior | yes/no/unknown | pass/feedback route | |
| Resolution/time/frame inputs | | host input mapping | |
| Audio/sound source | yes/no | manual porting decision | |
| Inline source or authorized snapshot provenance | | cache/authorization boundary | |

### ShaderFrog

| ShaderFrog contract item | Present/value | Target implication | Notes |
| --- | --- | --- | --- |
| User-authorized vertex source | yes/no | vertex dialect/attribute mapping | |
| User-authorized fragment source | yes/no | fragment dialect/uniform mapping | |
| Graph/node export | yes/no/n-a | reconstruct graph or original design | |
| Material/Three.js context | | attributes, matrices, textures | |
| User-supplied-source-analysis authority | | no editor auto-fetch | |

### Godot Shaders

| Godot contract item | Present/value | Target implication | Notes |
| --- | --- | --- | --- |
| Canonical `/shader/<slug>/` page evidence | yes/no | provider/license gate | |
| `shader_type` | | material/render route | |
| `render_mode` values | | blend/cull/depth/light behavior | |
| Uniforms and hints | | controls/textures/defaults | |
| Built-ins and screen/depth textures | | host input availability | |
| Required assets | | asset authority/mapping | |
| Page/source-header license evidence | | reusable classification/caching gate | |

Record whether the result is page-evidence metadata only or has passed the
provider's authorized source-header cross-check. Do not infer final reuse from a
page declaration alone.

### Knowledge sources

| Knowledge contract item | Present/value | Use boundary | Notes |
| --- | --- | --- | --- |
| Canonical chapter/lesson/topic link | | citation | |
| Topic/algorithm learned | | original explanation/design | |
| Language and fallback link | | citation accessibility | |
| Link-only or full-text provider policy | | cache/copy boundary | |
| Required attribution/license notice | | delivery | |

For a link-only source such as The Book of Shaders, record themes and citations
in original words; do not copy or cache page text or examples.

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
- Feedback, history, video, keyboard, microphone/audio, cubemap, MRT, or external asset dependency:
- Division/domain/precision/NaN risks:
- Source-policy, license, attribution, copyleft, or redistribution constraints:
- Missing target-host inputs or unsupported pass topology:

## Readiness Decision

- Source contract: complete / incomplete / link-only learning reference
- Provider policy result: permitted / metadata-only / review-required / blocked
- Safe action now: study / original look-alike / feasibility only / implementation
- Blocking unknowns:
- User decisions still required:

An original look-alike must describe visual behavior independently and must not
reconstruct unavailable third-party code.
