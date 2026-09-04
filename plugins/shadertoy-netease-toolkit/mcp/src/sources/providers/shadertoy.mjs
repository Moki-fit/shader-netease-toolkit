import {
  createDescriptor,
  createResolvedSource,
  getPathParts,
  hasExactHost,
  hasNoQuery,
} from './url-policy.mjs';

const HOSTS = ['www.shadertoy.com'];
const SHADER_ID = /^[A-Za-z0-9]{6}$/;

export const descriptor = createDescriptor({
  id: 'shadertoy',
  displayName: 'Shadertoy',
  kind: 'shader',
  homepage: 'https://www.shadertoy.com/',
  accessMode: 'official-api',
  capabilities: ['resolve-url', 'legacy-shadertoy-mcp-delegation', 'local-analysis'],
  licensePolicy: {
    classification: 'unknown',
    reviewRequired: true,
    reuse: 'do-not-reuse-until-the-author-permits-it',
    attribution: 'preserve-the-source-link-and-author-attribution',
  },
  networkPolicy: {
    resolver: 'offline-only',
    allowedHosts: HOSTS,
    redirects: 'reject',
    queryParameters: 'none',
    cache: 'provider-controlled',
  },
  notes: [
    'Only canonical six-character /view/<id> URLs are recognized.',
    'Project import and sync remain in the legacy shadertoy-netease MCP; this source registry only resolves and analyzes links.',
    'Individual community shader licenses are not inferred from the platform.',
  ],
});

export function resolveUrl(candidate) {
  if (!hasExactHost(candidate, HOSTS) || !hasNoQuery(candidate)) {
    return null;
  }
  const path = getPathParts(candidate);
  if (!path || path.trailingSlash || path.segments.length !== 2 || path.segments[0] !== 'view') {
    return null;
  }

  const id = path.segments[1];
  if (!SHADER_ID.test(id)) {
    return null;
  }

  return createResolvedSource(descriptor, {
    id,
    canonicalUrl: `https://www.shadertoy.com/view/${id}`,
    metadata: {
      sourceType: 'community-shader',
      userWork: true,
      cacheScope: 'provider-controlled',
    },
  });
}
