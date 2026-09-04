# Provider source policy

Use this reference after `resolve_shader_source_url` or before proposing a
provider-specific import/sync action. The authoritative runtime result wins if a
site changes. A source URL is provenance, not a license grant.

| Provider | Resource type | Allowed acquisition | Cache/index policy | Reuse decision |
| --- | --- | --- | --- | --- |
| `shadertoy` | Community shader project | Existing official Public + API workflow or user-provided source | Legacy service controls its cache; remote actions require explicit auth/bound | Preserve explicit work license; absent evidence needs Shadertoy-specific review |
| `isf` | Official ISF standard-library file | Canonical Vidvox `ISF-Files` path | Explicit bounded automatic step indexing is allowed | MIT, retain upstream copyright/license notice |
| `twigl` | Player shader/share link | Inline user source or exact `ol=true&ss=<id>` share link | User-work license is unknown. With `user-owned` / `licensed` / `author-permission`, one bounded request to the fixed experimental Firebase snapshot endpoint is allowed; `reference-only` / `repository-license` are zero-network link/metadata only. Never enumerate channels or directories | Work-specific permission is required; do not treat the twigl program license as a work license |
| `book-of-shaders` | Numbered knowledge chapter | Exact chapter link, including `?lan=ch` | Link-only; page content cache is forbidden. The link seed prefers Chinese; chapters 14 and 16–18 have no verified Chinese Markdown, so it falls back to the English link only. `sync_shader_source_step` may only zero-network seed built-in original topic links | Learn/explain/cite; do not copy or redistribute page content |
| `shaderfrog` | Editor project | Exact editor link plus user-provided authorized export | No automatic project fetch or site crawl; capability is `user-supplied-source-analysis` only | Work-specific license/permission required |
| `godot-shaders` | Single canonical `/shader/<slug>/` shader page | Exact canonical link only | `reference-only` / `repository-license`: request only canonical page, retain page evidence/metadata, never call detail API, and do not finalize reusable classification without a source-header check. `user-owned` / `licensed` / `author-permission` + one unambiguous supported CC0/MIT/GPLv3 license scoped to the target article: request only fixed `/wp-json/shader_data/shader/<postId>`. Cache only when the leading source header has exactly one matching supported license; missing, restrictive, composite, or conflicting headers remain `review_required` with no source blob. Never crawl directories/media | CC0/MIT can be adapted with required notices; GPLv3 requires copyleft review; no final reusable decision without corroborated page/source evidence |
| `webgl-fundamentals` | Official course lesson | Eligible official lesson Markdown from the upstream course repository | Explicit bounded automatic full-text index only; exclude third-party folders/assets/images | BSD-3-Clause, retain upstream copyright/license notice |

## Required actions by policy result

- **Allowed with attribution:** preserve canonical URL, author/publisher, license
  evidence and required notice in the implementation/delivery.
- **Reference-only or link-only:** explain ideas in original words and cite the
  canonical link. Do not cache full page content or transform it into a source
  bundle.
- **Manual user source:** require the user to state that the content may be
  supplied to Codex/MCP, record its provenance, then use local analysis only.
- **Unknown or conflict:** do not distribute, cache as reusable source, or
  closely translate it. Offer a feasibility report or original look-alike.

Never make a one-provider default license apply to a different provider. In
particular, the Shadertoy default is not a fallback for twigl, ShaderFrog, Godot
Shaders, ISF or learning references.
