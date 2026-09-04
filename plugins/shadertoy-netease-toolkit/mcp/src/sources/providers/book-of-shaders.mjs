import {
  createDescriptor,
  createResolvedSource,
  getPathParts,
  hasExactHost,
  readUniqueQuery,
} from './url-policy.mjs';

const HOSTS = ['thebookofshaders.com'];
const CHAPTER = /^\d{2}$/;

export const descriptor = createDescriptor({
  id: 'book-of-shaders',
  displayName: 'The Book of Shaders',
  kind: 'knowledge',
  homepage: 'https://thebookofshaders.com/',
  accessMode: 'reference-only',
  capabilities: ['resolve-url', 'knowledge-reference'],
  licensePolicy: {
    classification: 'no-reuse',
    reviewRequired: true,
    reuse: 'reference-only-do-not-copy-or-cache-the-page-content',
    attribution: 'cite-the-original-chapter-url',
  },
  networkPolicy: {
    resolver: 'offline-only',
    allowedHosts: HOSTS,
    redirects: 'reject',
    queryParameters: ['lan'],
    cache: 'forbidden',
  },
  notes: [
    'Only numbered chapter URLs are recognized.',
    'Chinese chapters use the explicit ?lan=ch language selector and remain reference-only.',
  ],
});

export function resolveUrl(candidate) {
  if (!hasExactHost(candidate, HOSTS)) {
    return null;
  }
  const path = getPathParts(candidate);
  if (!path || path.segments.length !== 1 || !CHAPTER.test(path.segments[0])) {
    return null;
  }
  const query = readUniqueQuery(candidate, ['lan']);
  if (!query) {
    return null;
  }
  const language = query.has('lan') ? query.get('lan') : 'default';
  if (!['default', 'ch', 'en'].includes(language)) {
    return null;
  }

  const chapter = path.segments[0];
  const languageQuery = language === 'default' ? '' : `?lan=${language}`;
  return createResolvedSource(descriptor, {
    id: `chapter-${chapter}-${language}`,
    canonicalUrl: `https://thebookofshaders.com/${chapter}/${languageQuery}`,
    metadata: {
      sourceType: 'numbered-chapter',
      chapter,
      language,
      cacheScope: 'none',
    },
  });
}
