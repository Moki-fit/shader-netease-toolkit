import { createHash } from 'node:crypto';

import {
  createDescriptor,
  createResolvedSource,
  getPathParts,
  hasExactHost,
  isSafeIdentifier,
  readUniqueQuery,
  utf8Length,
} from './url-policy.mjs';

const HOSTS = ['twigl.app'];
const MAX_INLINE_SOURCE_BYTES = 64 * 1024;
const MAX_INLINE_SOUND_SOURCE_BYTES = 64 * 1024;
const MODE = /^(?:[0-9]|1[01])$/;

export const descriptor = createDescriptor({
  id: 'twigl',
  displayName: 'twigl.app',
  kind: 'shader',
  homepage: 'https://twigl.app/',
  accessMode: 'user-link',
  capabilities: ['resolve-url', 'inline-source-analysis', 'single-snapshot-fetch'],
  licensePolicy: {
    classification: 'unknown',
    reviewRequired: true,
    reuse: 'do-not-reuse-until-the-work-author-permits-it',
    attribution: 'preserve-the-source-link-and-work-author-attribution',
  },
  networkPolicy: {
    resolver: 'offline-only',
    allowedHosts: [...HOSTS, 'twigl-f67a0.firebaseio.com'],
    allowedEndpoints: ['/', '/snapshot/<snapshotId>.json'],
    redirects: 'reject',
    queryParameters: ['mode', 'source', 'sound', 'soundsource', 'ol', 'ss'],
    cache: 'authorized-single-item-only-after-work-specific-review',
  },
  notes: [
    'Inline projects require mode=0..11&source=..., with optional sound=true&soundsource=....',
    'Modes 8 through 11 use MRT/backbuffer semantics; audio source requires a manual porting decision.',
    'Only an explicit ol=true&ss=<id> share link may trigger one bounded lookup at the fixed experimental snapshot endpoint.',
    'reference-only and repository-license imports remain zero-network; only user-owned, licensed, or author-permission may request that snapshot.',
    'The ch query parameter is deliberately rejected; the twigl repository license does not license individual works.',
  ],
});

function isRootPath(candidate) {
  const path = getPathParts(candidate);
  return Boolean(path) && path.segments.length === 0;
}

function inlineId(mode, source, soundSource) {
  const identity = JSON.stringify({ mode, source, soundSource: soundSource || null });
  return `inline-sha256-${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

export function resolveUrl(candidate) {
  if (!hasExactHost(candidate, HOSTS) || !isRootPath(candidate)) {
    return null;
  }
  const query = readUniqueQuery(candidate, ['mode', 'source', 'sound', 'soundsource', 'ol', 'ss']);
  if (!query) {
    return null;
  }

  if (query.has('source')) {
    const source = query.get('source');
    const mode = query.get('mode');
    const soundEnabled = query.get('sound') === 'true';
    const soundSource = query.get('soundsource');
    const hasAudioParameters = query.has('sound') || query.has('soundsource');
    if (
      !mode
      || !MODE.test(mode)
      || !source
      || utf8Length(source) > MAX_INLINE_SOURCE_BYTES
      || (!hasAudioParameters && query.size !== 2)
      || (hasAudioParameters && (
        query.size !== 4
        || !soundEnabled
        || !soundSource
        || utf8Length(soundSource) > MAX_INLINE_SOUND_SOURCE_BYTES
      ))
    ) {
      return null;
    }
    const id = inlineId(mode, source, soundSource);
    const canonicalParameters = [['mode', mode], ['source', source]];
    if (soundEnabled) {
      canonicalParameters.push(['sound', 'true'], ['soundsource', soundSource]);
    }
    const canonicalQuery = new URLSearchParams(canonicalParameters).toString();
    return createResolvedSource(descriptor, {
      id,
      canonicalUrl: `https://twigl.app/?${canonicalQuery}`,
      accessMode: 'inline-user-source',
      metadata: {
        sourceType: 'inline-user-source',
        inlineSource: source,
        mode: Number(mode),
        contentHash: id.slice('inline-'.length),
        cacheScope: 'caller-controlled-memory-only',
        audio: soundEnabled ? {
          enabled: true,
          inlineSoundSource: soundSource,
          requiresManualPorting: true,
        } : {
          enabled: false,
        },
        renderTargets: Number(mode) >= 8 ? 'mrt-or-backbuffer-review-required' : 'single-target',
        userWork: true,
      },
    });
  }

  const shareId = query.get('ss');
  if (
    query.size !== 2
    || query.get('ol') !== 'true'
    || !isSafeIdentifier(shareId)
  ) {
    return null;
  }
  return createResolvedSource(descriptor, {
    id: shareId,
    canonicalUrl: `https://twigl.app/?ol=true&ss=${encodeURIComponent(shareId)}`,
    accessMode: 'user-link',
    metadata: {
      sourceType: 'user-share-link',
      shareId,
      sourceAvailableInline: false,
      requiresUserSuppliedSource: true,
      userWork: true,
    },
  });
}
