import {
  createDescriptor,
  createResolvedSource,
  getPathParts,
  hasExactHost,
  hasNoQuery,
  isSafeIdentifier,
} from './url-policy.mjs';

const HOSTS = ['shaderfrog.com', 'www.shaderfrog.com'];

export const descriptor = createDescriptor({
  id: 'shaderfrog',
  displayName: 'ShaderFrog',
  kind: 'shader',
  homepage: 'https://shaderfrog.com/',
  accessMode: 'manual-user-supplied',
  capabilities: ['resolve-url', 'user-supplied-source-analysis', 'local-analysis'],
  licensePolicy: {
    classification: 'unknown',
    reviewRequired: true,
    reuse: 'do-not-reuse-until-the-work-author-permits-it',
    attribution: 'preserve-the-source-link-and-work-author-attribution',
  },
  networkPolicy: {
    resolver: 'offline-only',
    allowedHosts: HOSTS,
    redirects: 'reject',
    queryParameters: 'none',
    cache: 'none-until-user-supplies-authorized-source',
  },
  notes: [
    'Only /editor/<safe-id> and official 2.0 /2/editor/<safe-id> share links are recognized.',
    'The linked editor project is not fetched automatically.',
  ],
});

export function resolveUrl(candidate) {
  if (!hasExactHost(candidate, HOSTS) || !hasNoQuery(candidate)) {
    return null;
  }
  const path = getPathParts(candidate);
  if (!path || path.trailingSlash) {
    return null;
  }
  const isLegacyEditor = path.segments.length === 2 && path.segments[0] === 'editor';
  const isVersionTwoEditor = path.segments.length === 3 && path.segments[0] === '2' && path.segments[1] === 'editor';
  if (!isLegacyEditor && !isVersionTwoEditor) {
    return null;
  }
  const id = path.segments.at(-1);
  if (!isSafeIdentifier(id) || id === 'create') {
    return null;
  }
  return createResolvedSource(descriptor, {
    id,
    canonicalUrl: `https://shaderfrog.com/editor/${encodeURIComponent(id)}`,
    metadata: {
      sourceType: 'editor-link',
      editorId: id,
      requiresUserSuppliedSource: true,
      userWork: true,
    },
  });
}
