import {
  createDescriptor,
  createResolvedSource,
  getPathParts,
  hasExactHost,
  hasNoQuery,
} from './url-policy.mjs';

const HOSTS = ['godotshaders.com', 'www.godotshaders.com'];
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export const descriptor = createDescriptor({
  id: 'godot-shaders',
  displayName: 'Godot Shaders',
  kind: 'shader',
  homepage: 'https://godotshaders.com/',
  accessMode: 'user-link',
  capabilities: ['resolve-url', 'single-item-fetch', 'local-analysis'],
  licensePolicy: {
    classification: 'unknown',
    reviewRequired: true,
    reuse: 'do-not-reuse-until-the-work-author-permits-it',
    attribution: 'preserve-the-source-link-and-work-author-attribution',
  },
  networkPolicy: {
    resolver: 'offline-only',
    allowedHosts: HOSTS,
    allowedEndpoints: [
      '/shader/<slug>/',
      '/wp-json/shader_data/shader/<postId>',
    ],
    redirects: 'reject',
    queryParameters: 'none',
    cache: 'single-item-after-per-work-license-gate',
  },
  notes: [
    'Only canonical /shader/<slug>/ links are recognized.',
    'Fetch the canonical page first to parse its postId, then use only the matching fixed detail endpoint.',
    'Each work must pass a license gate before it is cached or recommended after its source and headers are inspected.',
  ],
});

export function resolveUrl(candidate) {
  if (!hasExactHost(candidate, HOSTS) || !hasNoQuery(candidate)) {
    return null;
  }
  const path = getPathParts(candidate);
  if (!path || !path.trailingSlash || path.segments.length !== 2 || path.segments[0] !== 'shader') {
    return null;
  }
  const slug = path.segments[1];
  if (!SLUG.test(slug)) {
    return null;
  }
  return createResolvedSource(descriptor, {
    id: slug,
    canonicalUrl: `https://godotshaders.com/shader/${slug}/`,
    metadata: {
      sourceType: 'shader-page-link',
      slug,
      licenseGate: 'per-work-before-cache-or-recommendation',
      requiresLicenseReview: true,
      userWork: true,
    },
  });
}
