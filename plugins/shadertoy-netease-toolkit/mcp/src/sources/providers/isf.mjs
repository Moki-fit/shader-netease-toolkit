import {
  createDescriptor,
  createResolvedSource,
  encodePathSegments,
  getPathParts,
  hasExactHost,
  hasNoQuery,
} from './url-policy.mjs';

const GITHUB_HOST = 'github.com';
const RAW_GITHUB_HOST = 'raw.githubusercontent.com';
const REPOSITORY_SEGMENTS = ['Vidvox', 'ISF-Files'];
const REVISION = /^[A-Za-z0-9._-]{1,128}$/;
const ISF_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._'&()+-]{0,191}$/;

export const descriptor = createDescriptor({
  id: 'isf',
  displayName: 'Interactive Shader Format standard library',
  kind: 'shader',
  homepage: 'https://isf.video/',
  accessMode: 'official-repository',
  capabilities: ['resolve-url', 'official-repository-sync', 'local-analysis'],
  licensePolicy: {
    classification: 'MIT',
    spdx: 'MIT',
    reviewRequired: false,
    reuse: 'allowed-subject-to-the-upstream-license',
    attribution: 'retain-the-upstream-copyright-and-license-notice',
  },
  networkPolicy: {
    resolver: 'offline-only',
    allowedHosts: [GITHUB_HOST, RAW_GITHUB_HOST],
    redirects: 'reject',
    queryParameters: 'none',
    cache: 'first-party-source',
  },
  notes: [
    'Automatic synchronization is limited to Vidvox/ISF-Files ISF/*.fs files.',
    'The registry intentionally does not resolve editor.isf.video links without a verified canonical item format.',
  ],
});

function isValidIsfFilePath(segments) {
  return segments.length === 2
    && segments[0] === 'ISF'
    && segments.every((segment) => ISF_PATH_SEGMENT.test(segment))
    && segments.at(-1).endsWith('.fs');
}

function parseRepositoryPath(candidate) {
  const path = getPathParts(candidate);
  if (!path || path.trailingSlash || !hasNoQuery(candidate)) {
    return null;
  }

  const { segments } = path;
  let revision;
  let fileSegments;
  let inputForm;
  if (candidate.url.hostname === GITHUB_HOST) {
    if (
      segments.length < 6
      || segments[0] !== REPOSITORY_SEGMENTS[0]
      || segments[1] !== REPOSITORY_SEGMENTS[1]
      || segments[2] !== 'blob'
      || segments[4] !== 'ISF'
    ) {
      return null;
    }
    revision = segments[3];
    fileSegments = segments.slice(4);
    inputForm = 'github-blob';
  } else if (candidate.url.hostname === RAW_GITHUB_HOST) {
    if (
      segments.length < 5
      || segments[0] !== REPOSITORY_SEGMENTS[0]
      || segments[1] !== REPOSITORY_SEGMENTS[1]
      || segments[3] !== 'ISF'
    ) {
      return null;
    }
    revision = segments[2];
    fileSegments = segments.slice(3);
    inputForm = 'github-raw';
  } else {
    return null;
  }

  if (!REVISION.test(revision) || !isValidIsfFilePath(fileSegments)) {
    return null;
  }
  return { revision, fileSegments, inputForm };
}

export function resolveUrl(candidate) {
  if (!hasExactHost(candidate, [GITHUB_HOST, RAW_GITHUB_HOST])) {
    return null;
  }
  const resolved = parseRepositoryPath(candidate);
  if (!resolved) {
    return null;
  }

  const relativePath = resolved.fileSegments.join('/');
  const canonicalUrl = `https://${RAW_GITHUB_HOST}${encodePathSegments([
    ...REPOSITORY_SEGMENTS,
    resolved.revision,
    ...resolved.fileSegments,
  ])}`;
  return createResolvedSource(descriptor, {
    id: relativePath,
    canonicalUrl,
    metadata: {
      sourceType: 'official-isf-library-file',
      repository: 'Vidvox/ISF-Files',
      revision: resolved.revision,
      relativePath,
      inputForm: resolved.inputForm,
    },
  });
}
