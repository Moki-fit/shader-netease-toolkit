const MAX_URL_LENGTH = 128 * 1024;

function isString(value) {
  return typeof value === 'string';
}

function hasMalformedPercentEncoding(value) {
  return /%(?![0-9a-f]{2})/i.test(value);
}

function splitRawUrl(value) {
  const match = /^https:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?$/i.exec(value);
  if (!match) {
    return null;
  }

  return {
    authority: match[1],
    path: match[2] || '',
    query: match[3] == null ? '' : match[3],
    hasQuery: match[3] != null,
  };
}

function hasExplicitPort(authority) {
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostPort.startsWith('[')) {
    return /\]:\d*$/.test(hostPort);
  }
  return /:\d*$/.test(hostPort);
}

function hasUnsafePathEncoding(path) {
  return /\\|%(?:2e|2f|5c)/i.test(path);
}

function decodePathSegment(segment) {
  let decoded = segment;
  for (let pass = 0; pass < 3; pass += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) {
      break;
    }
    decoded = next;
  }

  if (
    decoded.length === 0
    || decoded === '.'
    || decoded === '..'
    || decoded.includes('/')
    || decoded.includes('\\')
    || /%(?:2e|2f|5c)/i.test(decoded)
  ) {
    return null;
  }
  return decoded;
}

export function freezeValue(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    freezeValue(child);
  }
  return Object.freeze(value);
}

export function createDescriptor(fields) {
  return freezeValue({
    id: fields.id,
    displayName: fields.displayName,
    kind: fields.kind,
    homepage: fields.homepage,
    accessMode: fields.accessMode,
    capabilities: [...fields.capabilities],
    licensePolicy: { ...fields.licensePolicy },
    networkPolicy: { ...fields.networkPolicy },
    notes: [...fields.notes],
  });
}

/**
 * Parses only an absolute HTTPS URL with an exact, non-credential authority.
 * It intentionally returns null instead of throwing so callers can safely use
 * it as a recognizer for untrusted pasted links.
 */
export function parseSafeHttpsUrl(input) {
  if (
    !isString(input)
    || input.length === 0
    || input.length > MAX_URL_LENGTH
    || input !== input.trim()
    || /[\u0000-\u001f\u007f\\]/.test(input)
    || input.includes('#')
  ) {
    return null;
  }

  const raw = splitRawUrl(input);
  if (
    !raw
    || raw.authority.length === 0
    || raw.authority.includes('@')
    || hasExplicitPort(raw.authority)
    || hasMalformedPercentEncoding(raw.path)
    || hasMalformedPercentEncoding(raw.query)
    || hasUnsafePathEncoding(raw.path)
  ) {
    return null;
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || url.hostname.length === 0
    || url.hash
  ) {
    return null;
  }

  return Object.freeze({ url, raw });
}

export function hasExactHost(candidate, hosts) {
  return Boolean(candidate) && hosts.includes(candidate.url.hostname);
}

export function getPathParts(candidate) {
  if (!candidate || typeof candidate.raw.path !== 'string') {
    return null;
  }
  const { path } = candidate.raw;
  if (path === '') {
    return Object.freeze({ segments: Object.freeze([]), trailingSlash: false });
  }
  if (!path.startsWith('/')) {
    return null;
  }

  const rawParts = path.slice(1).split('/');
  const trailingSlash = rawParts.at(-1) === '';
  if (trailingSlash) {
    rawParts.pop();
  }
  if (rawParts.some((part) => part.length === 0)) {
    return null;
  }

  const segments = [];
  for (const part of rawParts) {
    const decoded = decodePathSegment(part);
    if (decoded == null) {
      return null;
    }
    segments.push(decoded);
  }
  return Object.freeze({ segments: Object.freeze(segments), trailingSlash });
}

export function readUniqueQuery(candidate, allowedKeys) {
  if (!candidate) {
    return null;
  }
  if (!candidate.raw.hasQuery) {
    return new Map();
  }
  if (candidate.raw.query.length === 0) {
    return null;
  }

  const values = new Map();
  for (const [key, value] of candidate.url.searchParams.entries()) {
    if (!allowedKeys.includes(key) || values.has(key)) {
      return null;
    }
    values.set(key, value);
  }
  return values;
}

export function hasNoQuery(candidate) {
  return Boolean(candidate) && !candidate.raw.hasQuery;
}

export function encodePathSegments(segments, trailingSlash = false) {
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return `/${encoded}${trailingSlash ? '/' : ''}`;
}

export function createResolvedSource(provider, fields) {
  return Object.freeze({
    ref: Object.freeze({ provider: provider.id, id: fields.id }),
    kind: provider.kind,
    canonicalUrl: fields.canonicalUrl,
    accessMode: fields.accessMode || provider.accessMode,
    licensePolicy: provider.licensePolicy,
    metadata: freezeValue({ ...fields.metadata }),
  });
}

export function isSafeIdentifier(value, pattern = /^[A-Za-z0-9_-]{1,128}$/) {
  return typeof value === 'string' && pattern.test(value);
}

export function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}
