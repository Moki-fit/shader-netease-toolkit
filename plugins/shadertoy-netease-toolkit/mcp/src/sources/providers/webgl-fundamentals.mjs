import {
  createDescriptor,
  createResolvedSource,
  getPathParts,
  hasExactHost,
  hasNoQuery,
} from './url-policy.mjs';

const HOSTS = ['webglfundamentals.org'];
// The upstream lesson repository contains a small number of legitimate names
// with consecutive or trailing '-' characters.  Keep the character set narrow
// while accepting that real filename shape; path and encoded traversal are
// rejected before this matcher runs.
const LESSON_SLUG = /^[a-z0-9][a-z0-9_-]{0,254}$/;

export const descriptor = createDescriptor({
  id: 'webgl-fundamentals',
  displayName: 'WebGL Fundamentals',
  kind: 'knowledge',
  homepage: 'https://webglfundamentals.org/',
  accessMode: 'official-repository',
  capabilities: ['resolve-url', 'official-repository-sync', 'knowledge-cache'],
  licensePolicy: {
    classification: 'BSD-3-Clause',
    spdx: 'BSD-3-Clause',
    reviewRequired: false,
    reuse: 'allowed-subject-to-the-upstream-license',
    attribution: 'retain-the-upstream-copyright-and-license-notice',
  },
  networkPolicy: {
    resolver: 'offline-only',
    allowedHosts: HOSTS,
    redirects: 'reject',
    queryParameters: 'none',
    cache: 'first-party-lessons-markdown-only',
  },
  notes: [
    'Only /webgl/lessons/<slug>.html and its explicit zh_cn variant are recognized.',
    'A separate official-repository synchronizer may cache first-party lesson Markdown only.',
    'Do not synchronize thirdparty directories, generated assets, or arbitrary linked pages.',
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
  const { segments } = path;
  let language = 'en';
  let filename;
  if (segments.length === 4 && segments[0] === 'webgl' && segments[1] === 'lessons' && segments[2] === 'zh_cn') {
    language = 'zh_cn';
    filename = segments[3];
  } else if (segments.length === 3 && segments[0] === 'webgl' && segments[1] === 'lessons') {
    filename = segments[2];
  } else {
    return null;
  }
  const match = /^(.+)\.html$/.exec(filename);
  if (!match || !LESSON_SLUG.test(match[1])) {
    return null;
  }
  const slug = match[1];
  const languagePrefix = language === 'zh_cn' ? 'zh_cn/' : '';
  return createResolvedSource(descriptor, {
    id: `${languagePrefix}${slug}`,
    canonicalUrl: `https://webglfundamentals.org/webgl/lessons/${languagePrefix}${slug}.html`,
    metadata: {
      sourceType: 'lesson',
      slug,
      language,
      cacheScope: 'first-party-lessons-markdown-only',
    },
  });
}
