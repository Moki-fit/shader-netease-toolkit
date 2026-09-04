import { createHash } from 'node:crypto';

const MAX_METADATA_TEXT = 16 * 1024;
const MAX_TAGS = 32;

function byteSlice(text, maximum = MAX_METADATA_TEXT) {
  if (typeof text !== 'string') {
    return '';
  }
  const bytes = Buffer.from(text, 'utf8');
  return bytes.byteLength <= maximum ? text : bytes.subarray(0, maximum).toString('utf8');
}

function cleanText(value, maximum = MAX_METADATA_TEXT) {
  return byteSlice(typeof value === 'string' ? value.trim() : '', maximum);
}

function cleanTags(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const tags = [];
  for (const item of value) {
    const tag = cleanText(String(item), 256);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
    if (tags.length >= MAX_TAGS) {
      break;
    }
  }
  return tags;
}

function pathTitle(path, extension) {
  const last = String(path || '').split('/').at(-1) || 'Untitled resource';
  return cleanText(last.endsWith(extension) ? last.slice(0, -extension.length) : last, 4 * 1024)
    || 'Untitled resource';
}

function isoNow(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function classifiedRights(spdx, evidence, options = {}) {
  return {
    status: options.status || 'classified',
    spdx,
    reviewRequired: Boolean(options.reviewRequired),
    adaptation: options.adaptation || 'verify-upstream-terms',
    commercial: options.commercial || 'verify-upstream-terms',
    attribution: options.attribution || 'required',
    evidence: Array.isArray(evidence) ? evidence : [{ kind: 'provider-policy', text: String(evidence || '') }],
  };
}

export function reviewRights(reason, evidence = []) {
  return {
    status: 'review_required',
    spdx: null,
    reviewRequired: true,
    adaptation: 'unknown',
    commercial: 'unknown',
    attribution: 'preserve-source-link',
    reason: cleanText(reason, 1_024) || 'No reusable-work license was verified.',
    evidence: Array.isArray(evidence) ? evidence : [],
  };
}

function parseIsfHeader(source) {
  if (typeof source !== 'string') {
    throw new TypeError('ISF source must be text.');
  }
  const prefix = source.slice(0, 256 * 1024);
  const match = /^\s*\/\*\s*(\{[\s\S]*?\})\s*\*\//.exec(prefix);
  if (!match) {
    throw new Error('The ISF source does not begin with its required JSON comment header.');
  }
  let header;
  try {
    header = JSON.parse(match[1]);
  } catch {
    throw new Error('The ISF JSON comment header is invalid.');
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new Error('The ISF JSON comment header must be an object.');
  }
  return header;
}

function normaliseIsfInputs(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 128).map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { invalid: true };
    }
    const result = {};
    for (const key of ['NAME', 'TYPE', 'LABEL', 'DEFAULT', 'MIN', 'MAX', 'IDENTITY', 'VALUES', 'LABELS']) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        const value = input[key];
        if (typeof value === 'string') {
          result[key] = cleanText(value, 4 * 1024);
        } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
          result[key] = value;
        } else if (Array.isArray(value)) {
          result[key] = value.slice(0, 64).map((item) => typeof item === 'string' ? cleanText(item, 512) : item);
        }
      }
    }
    return result;
  });
}

function normaliseIsfPasses(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 64).map((pass, index) => {
    if (!pass || typeof pass !== 'object' || Array.isArray(pass)) {
      return { index, invalid: true };
    }
    const result = { index };
    for (const key of ['TARGET', 'PERSISTENT', 'FLOAT', 'WIDTH', 'HEIGHT', 'DESCRIPTION']) {
      if (!Object.prototype.hasOwnProperty.call(pass, key)) {
        continue;
      }
      const value = pass[key];
      if (typeof value === 'string') {
        result[key] = cleanText(value, 4 * 1024);
      } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        result[key] = value;
      }
    }
    return result;
  });
}

function normaliseIsfImported(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const entries = [];
  for (const [name, details] of Object.entries(value).slice(0, 128)) {
    const path = details && typeof details === 'object' && typeof details.PATH === 'string'
      ? cleanText(details.PATH, 4 * 1024)
      : '';
    entries.push({
      name: cleanText(name, 256),
      path: path || null,
      // This is metadata only. Imported assets are never requested by the provider service.
      relativePath: Boolean(path) && !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..'),
    });
  }
  return entries;
}

function isfRequirements(source, inputs, passes) {
  const requirements = [];
  if (/\b(?:IMG_PIXEL|IMG_NORM_PIXEL|IMG_SIZE)\b/.test(source)) requirements.push('isf-image-sampling');
  if (/\bPASSINDEX\b/.test(source) || passes.length > 1) requirements.push('multi-pass');
  // ISF permits the boolean form as well as a positive numeric value.  Do not
  // coerce strings such as "1": the JSON header must express persistence as a
  // boolean or number, not a truthy user string.
  if (passes.some((pass) => pass.PERSISTENT === true
    || (typeof pass.PERSISTENT === 'number' && Number.isFinite(pass.PERSISTENT) && pass.PERSISTENT > 0))) {
    requirements.push('persistent-buffer');
  }
  if (inputs.some((input) => ['audio', 'audioFFT'].includes(input.TYPE))) requirements.push('audio-input');
  if (inputs.some((input) => input.TYPE === 'image')) requirements.push('image-input');
  return requirements;
}

export function normalizeIsfResource({ ref, canonicalUrl, path, fragmentSource, vertexSource, commit, blobSha, now }) {
  const header = parseIsfHeader(fragmentSource);
  const inputs = normaliseIsfInputs(header.INPUTS);
  const passes = normaliseIsfPasses(header.PASSES);
  const imported = normaliseIsfImported(header.IMPORTED);
  const credit = cleanText(header.CREDIT, 4 * 1024);
  const title = cleanText(header.LABEL || header.NAME, 4 * 1024) || pathTitle(path, '.fs');
  const description = cleanText(header.DESCRIPTION, MAX_METADATA_TEXT);
  const tags = cleanTags(header.CATEGORIES);
  const blobs = [{ role: 'fragment', mimeType: 'text/x-glsl', body: fragmentSource }];
  if (typeof vertexSource === 'string' && vertexSource) {
    blobs.push({ role: 'vertex', mimeType: 'text/x-glsl', body: vertexSource });
  }
  return {
    ref,
    kind: 'shader',
    title,
    author: credit,
    description,
    tags,
    language: 'isf-glsl',
    canonicalUrl,
    rights: classifiedRights('MIT', [{ kind: 'repository-license', text: 'Vidvox/ISF-Files standard library MIT license.' }], {
      adaptation: 'allowed',
      commercial: 'allowed',
    }),
    provenance: {
      acquisition: 'official-github-repository',
      repository: 'Vidvox/ISF-Files',
      revision: commit,
      path,
      blobSha: blobSha || null,
      fetchedAt: isoNow(now),
    },
    authorization: {
      basis: 'repository-license',
      assertedBy: 'official-provider-policy',
    },
    contentPolicy: 'full_source',
    metadata: {
      format: 'isf',
      isfVersion: cleanText(String(header.ISFVSN || header.VSN || '1'), 256),
      credit: credit || null,
      inputs,
      passes,
      imported,
      importedAssetsDownloaded: false,
      hostRequirements: isfRequirements(fragmentSource, inputs, passes),
    },
    blobs,
  };
}

function markdownField(source, name, maximum) {
  const expression = new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, 'im');
  return cleanText(expression.exec(source)?.[1], maximum);
}

function markdownTitle(source, fallback) {
  const declared = markdownField(source, 'title', 4 * 1024);
  if (declared) {
    return declared;
  }
  const heading = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m.exec(source);
  return cleanText(heading?.[1], 4 * 1024) || fallback;
}

function markdownDescription(source, title) {
  const declared = markdownField(source, 'description', 2_000);
  if (declared) {
    return declared;
  }
  const lines = source.split(/\r?\n/);
  const lead = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.startsWith('![')) {
      continue;
    }
    lead.push(trimmed.replace(/\[(.*?)\]\([^)]*\)/g, '$1'));
    if (lead.join(' ').length > 1_500) break;
  }
  const text = cleanText(lead.join(' '), 2_000);
  return text === title ? '' : text;
}

export function normalizeWebglLesson({ ref, canonicalUrl, path, source, commit, blobSha, now }) {
  const title = markdownTitle(source, pathTitle(path, '.md'));
  const language = path.includes('/zh_cn/') ? 'zh-CN' : 'en';
  return {
    ref,
    kind: 'knowledge',
    title,
    description: markdownDescription(source, title),
    tags: ['webgl', 'glsl', language === 'zh-CN' ? '中文' : 'english'],
    language,
    canonicalUrl,
    rights: classifiedRights('BSD-3-Clause', [{ kind: 'repository-license', text: 'gfxfundamentals/webgl-fundamentals BSD-3-Clause license.' }], {
      adaptation: 'allowed',
      commercial: 'allowed',
    }),
    provenance: {
      acquisition: 'official-github-repository',
      repository: 'gfxfundamentals/webgl-fundamentals',
      revision: commit,
      path,
      blobSha: blobSha || null,
      fetchedAt: isoNow(now),
    },
    authorization: {
      basis: 'repository-license',
      assertedBy: 'official-provider-policy',
    },
    contentPolicy: 'full_text',
    metadata: {
      format: 'markdown',
      sourcePath: path,
      languagePriority: language === 'zh-CN' ? 'preferred-chinese' : 'english-fallback',
      thirdPartyAssetsDownloaded: false,
    },
    blobs: [{ role: 'article', mimeType: 'text/markdown', body: source }],
  };
}

export function normalizeLinkOnlyResource({ resolved, title, description, authorizationBasis, now, tags = [] }) {
  return {
    ref: resolved.ref,
    kind: resolved.kind === 'knowledge' ? 'knowledge' : 'shader',
    title: cleanText(title, 4 * 1024) || `${resolved.ref.provider} reference`,
    description: cleanText(description, MAX_METADATA_TEXT),
    tags: cleanTags(tags),
    canonicalUrl: resolved.canonicalUrl,
    rights: reviewRights('This provider is reference-only or the linked user work has no reusable-work license.'),
    provenance: { acquisition: 'user-provided-link', fetchedAt: isoNow(now) },
    authorization: authorizationBasis ? { basis: authorizationBasis, assertedBy: 'caller' } : null,
    contentPolicy: 'link_only',
    metadata: { ...resolved.metadata, linkOnly: true, bodyBytes: 0 },
    blobs: [],
  };
}

function sanitizedTwiglMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const {
    inlineSource,
    inlineSoundSource,
    source,
    soundSource,
    code,
    fragment,
    audio,
    ...safe
  } = value;
  void inlineSource;
  void inlineSoundSource;
  void source;
  void soundSource;
  void code;
  void fragment;
  if (audio && typeof audio === 'object' && !Array.isArray(audio)) {
    const {
      inlineSoundSource: ignoredInlineSoundSource,
      source: ignoredSource,
      soundSource: ignoredSoundSource,
      code: ignoredCode,
      ...safeAudio
    } = audio;
    void ignoredInlineSoundSource;
    void ignoredSource;
    void ignoredSoundSource;
    void ignoredCode;
    safe.audio = safeAudio;
  }
  return safe;
}

export function normalizeTwiglResource({ resolved, source, soundSource, mode, authorizationBasis, now, provenance = {} }) {
  const cacheAllowed = ['user-owned', 'licensed', 'author-permission'].includes(authorizationBasis);
  const hash = typeof source === 'string'
    ? createHash('sha256').update(source, 'utf8').digest('hex')
    : null;
  const soundHash = typeof soundSource === 'string'
    ? createHash('sha256').update(soundSource, 'utf8').digest('hex')
    : null;
  const cachedBlobs = cacheAllowed && source
    ? [
      { role: 'fragment', mimeType: 'text/x-glsl', body: source },
      ...(soundSource ? [{ role: 'sound', mimeType: 'text/x-glsl', body: soundSource }] : []),
    ]
    : [];
  return {
    ref: resolved.ref,
    kind: 'shader',
    title: `twigl ${resolved.ref.id}`,
    description: source ? 'User-supplied twigl shader source.' : 'twigl share-link reference; source was not cached.',
    tags: ['twigl', 'user-work'],
    language: 'glsl-es',
    // An inline twigl URL carries the source text in its query string. Keep a
    // stable, non-content URL in the local record; the content hash is the
    // identity and, when authorized, the source exists only in blobs.
    canonicalUrl: resolved.metadata?.sourceType === 'inline-user-source'
      ? 'https://twigl.app/'
      : resolved.canonicalUrl,
    rights: reviewRights('The twigl program license does not license a user work; review the work-specific permission.', [
      { kind: 'provider-policy', text: 'twigl user works are not assigned the platform MIT license.' },
    ]),
    provenance: {
      acquisition: source ? 'user-link-inline-or-snapshot' : 'user-link-reference',
      fetchedAt: isoNow(now),
      ...provenance,
    },
    authorization: authorizationBasis ? { basis: authorizationBasis, assertedBy: 'caller' } : null,
    contentPolicy: cacheAllowed && source ? 'user_authorized_source' : 'metadata_only',
    metadata: {
      ...sanitizedTwiglMetadata(resolved.metadata),
      mode: Number.isInteger(mode) ? mode : resolved.metadata?.mode ?? null,
      sourceSha256: hash,
      soundSourceSha256: soundHash,
      sourceCached: Boolean(cacheAllowed && source),
      sound: {
        present: Boolean(soundSource),
        cached: Boolean(cacheAllowed && source && soundSource),
        requiresManualPorting: Boolean(soundSource),
      },
      reviewRequired: true,
    },
    blobs: cachedBlobs,
  };
}

const SOURCE_HEADER_SPDX = Object.freeze({
  'CC0-1.0': 'CC0-1.0',
  MIT: 'MIT',
  'GPL-3.0-only': 'GPL-3.0-only',
});
const SOURCE_HEADER_SCAN_BYTES = 16 * 1024;
const MAX_SOURCE_HEADER_INPUT_BYTES = 2 * 1024 * 1024;
const SOURCE_HEADER_WHITESPACE = /[\t\v\f\r\n ]/;

function leadingSourceHeaderComment(source) {
  const fullSource = String(source || '');
  if (Buffer.byteLength(fullSource, 'utf8') > MAX_SOURCE_HEADER_INPUT_BYTES) {
    return { header: '', truncated: true };
  }
  // Skip a BOM and leading whitespace on the complete bounded source before
  // opening the small header window. Slicing before this step would let an
  // oversized whitespace prefix hide a comment that starts past the window.
  const start = /^\uFEFF?[\t\v\f\r\n ]*/.exec(fullSource)?.[0].length || 0;
  const remaining = fullSource.slice(start);
  const remainingBytes = Buffer.byteLength(remaining, 'utf8');
  const window = Buffer.from(remaining, 'utf8').subarray(0, SOURCE_HEADER_SCAN_BYTES).toString('utf8');
  const truncated = remainingBytes > SOURCE_HEADER_SCAN_BYTES;
  const comments = [];
  let cursor = 0;
  while (cursor < window.length) {
    let end = -1;
    if (window.startsWith('/*', cursor)) {
      end = window.indexOf('*/', cursor + 2);
      if (end < 0) {
        return { header: comments.concat(window.slice(cursor)).join('\n'), comments, truncated: true };
      }
      comments.push(window.slice(cursor, end + 2));
      cursor = end + 2;
    } else if (window.startsWith('//', cursor)) {
      end = window.indexOf('\n', cursor + 2);
      const lineEnd = end < 0 ? window.length : end;
      comments.push(window.slice(cursor, lineEnd));
      cursor = lineEnd;
    } else {
      break;
    }

    // A header may use separate block and line comments before the first GLSL
    // token.  Whitespace does not end that header; every following comment is
    // part of its declaration and must therefore pass the same strict grammar.
    while (cursor < window.length && SOURCE_HEADER_WHITESPACE.test(window[cursor])) cursor += 1;
    // A BOM is tolerated only at byte zero.  Treat one between header
    // comments as malformed rather than letting it hide a restrictive second
    // declaration behind the first SPDX line.
    if (window[cursor] === '\uFEFF') {
      return { header: comments.join('\n'), comments, truncated: false, invalid: true };
    }
  }
  if (!comments.length) {
    return { header: '', comments: [], truncated: false };
  }
  if (cursor === window.length && truncated) {
    return { header: comments.join('\n'), comments, truncated: true };
  }
  return { header: comments.join('\n'), comments, truncated: false };
}

function sourceHeaderLines(comments) {
  const lines = [];
  for (const comment of comments || []) {
    let body = String(comment || '');
    if (body.startsWith('/*') && body.endsWith('*/')) {
      body = body.slice(2, -2);
    } else if (body.startsWith('//')) {
      body = body.slice(2);
    }
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim().replace(/^\*\s?/, '').trim();
      if (line) lines.push(line);
    }
  }
  return lines;
}

function bambooMitHeader(lines) {
  // This is the published Procedural Bamboo declaration verbatim, not a
  // free-text license search.  Any extra non-empty line fails closed.
  return lines.length === 3
    && lines[0] === '竹シェーダー by あるる（きのもと 結衣） @arlez80'
    && lines[1] === 'Bamboo Shader by Yui Kinomoto'
    && lines[2] === 'MIT License'
    ? 'MIT'
    : null;
}

// Cache only a complete positive grammar.  The parser intentionally does not
// attempt to enumerate every possible restriction phrase: any extra leading
// comment content makes the declaration unsupported and therefore review-only.
function sourceHeaderLicenseDeclaration(source) {
  const headerInfo = leadingSourceHeaderComment(source);
  const { header } = headerInfo;
  if (!header && !headerInfo.truncated) {
    return { licenses: new Set(), evidence: '', declared: false, unrecognized: false, truncated: false };
  }
  const lines = sourceHeaderLines(headerInfo.comments);
  const exactSpdx = lines.length === 1
    ? /^SPDX-License-Identifier:\s*(CC0-1\.0|MIT|GPL-3\.0-only)$/.exec(lines[0])
    : null;
  const normalized = exactSpdx ? SOURCE_HEADER_SPDX[exactSpdx[1]] : bambooMitHeader(lines);
  const licenses = normalized && !headerInfo.truncated && !headerInfo.invalid ? new Set([normalized]) : new Set();
  const declared = Boolean(lines.length || headerInfo.truncated);
  const unrecognized = !normalized || Boolean(headerInfo.truncated) || Boolean(headerInfo.invalid);
  return {
    licenses,
    evidence: cleanText(header, 512),
    declared,
    unrecognized,
    truncated: Boolean(headerInfo.truncated),
  };
}

const VOID_HTML_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT_HTML_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const INERT_EVIDENCE_ELEMENTS = new Set([...RAW_TEXT_HTML_ELEMENTS, 'template', 'plaintext']);
// The page target must be a top-level WordPress post under ordinary structural
// wrappers.  Restricting this path positively avoids accepting markup that
// browsers parse with special insertion or foreign-content rules.
const TRUSTED_TARGET_ANCESTOR_ELEMENTS = new Set(['div', 'main', 'section']);
// A platform license block can be nested in the normal article layout, but its
// path and text subtree must stay in a small, ordinary-HTML subset.
const TRUSTED_LICENSE_BLOCK_WRAPPER_ELEMENTS = new Set(['div', 'main', 'section', 'footer', 'p', 'span']);
const TRUSTED_LICENSE_BLOCK_ELEMENTS = new Set(['div', 'p', 'span']);
const TRUSTED_LICENSE_EVIDENCE_ELEMENTS = new Set([
  'a', 'b', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'i', 'p', 'small', 'span', 'strong', 'sub', 'sup', 'time',
]);
const MAX_GODOT_HTML_ELEMENT_DEPTH = 256;
const MAX_GODOT_HTML_TOKENS = 50_000;

function htmlWhitespace(character) {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n' || character === '\f';
}

function htmlNameCharacter(character) {
  return /[A-Za-z0-9:_-]/.test(character || '');
}

function parseHtmlOpeningTag(source, start) {
  let cursor = start + 1;
  // `< article>` is text in HTML, not an element start.  Do not normalize it
  // into a trusted node merely because a later substring resembles a tag.
  if (htmlWhitespace(source[cursor])) return null;
  if (!/[A-Za-z]/.test(source[cursor] || '')) return null;
  const nameStart = cursor;
  while (htmlNameCharacter(source[cursor])) cursor += 1;
  if (cursor === nameStart) return null;
  const name = source.slice(nameStart, cursor).toLowerCase();
  const attributes = Object.create(null);
  while (cursor < source.length) {
    while (htmlWhitespace(source[cursor])) cursor += 1;
    if (source[cursor] === '>') return { name, attributes, selfClosing: false, end: cursor + 1 };
    if (source[cursor] === '/' && source[cursor + 1] === '>') return { name, attributes, selfClosing: true, end: cursor + 2 };
    const attributeStart = cursor;
    while (cursor < source.length && !htmlWhitespace(source[cursor]) && !['=', '>', '/'].includes(source[cursor])) cursor += 1;
    if (cursor === attributeStart) return { invalid: true };
    const attributeName = source.slice(attributeStart, cursor).toLowerCase();
    while (htmlWhitespace(source[cursor])) cursor += 1;
    let value = '';
    if (source[cursor] === '=') {
      cursor += 1;
      while (htmlWhitespace(source[cursor])) cursor += 1;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < source.length && source[cursor] !== quote) cursor += 1;
        if (cursor >= source.length) return { invalid: true };
        value = source.slice(valueStart, cursor);
        cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < source.length && !htmlWhitespace(source[cursor]) && !['>', '/'].includes(source[cursor])) cursor += 1;
        value = source.slice(valueStart, cursor);
      }
    }
    if (!Object.prototype.hasOwnProperty.call(attributes, attributeName)) attributes[attributeName] = value;
  }
  return { invalid: true };
}

function parseHtmlClosingTag(source, start) {
  if (!source.startsWith('</', start)) return null;
  let cursor = start + 2;
  if (htmlWhitespace(source[cursor])) return null;
  if (!/[A-Za-z]/.test(source[cursor] || '')) return null;
  const nameStart = cursor;
  while (htmlNameCharacter(source[cursor])) cursor += 1;
  if (cursor === nameStart) return null;
  const name = source.slice(nameStart, cursor).toLowerCase();
  while (htmlWhitespace(source[cursor])) cursor += 1;
  return source[cursor] === '>' ? { name, end: cursor + 1 } : null;
}

function skipHtmlMarkup(source, start) {
  let cursor = start;
  let quote = '';
  while (cursor < source.length) {
    const character = source[cursor];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return cursor + 1;
    }
    cursor += 1;
  }
  return source.length;
}

function inertElementEnd(source, start, name) {
  let cursor = start;
  while (cursor < source.length) {
    const candidate = source.indexOf('<', cursor);
    if (candidate < 0) return source.length;
    const closing = parseHtmlClosingTag(source, candidate);
    if (closing?.name === name) return closing.end;
    cursor = candidate + 1;
  }
  return source.length;
}

function appendHtmlText(parent, value) {
  if (value) parent.children.push({ type: 'text', value });
}

function parseGodotHtml(html) {
  const source = String(html || '');
  const root = { type: 'element', name: '#document', attributes: Object.create(null), children: [], malformed: false };
  const stack = [root];
  let cursor = 0;
  let tokenCount = 0;
  const consumeToken = () => {
    tokenCount += 1;
    if (tokenCount > MAX_GODOT_HTML_TOKENS) {
      root.malformed = true;
      return false;
    }
    return true;
  };
  while (cursor < source.length) {
    if (source[cursor] !== '<') {
      const next = source.indexOf('<', cursor);
      const end = next < 0 ? source.length : next;
      if (!consumeToken()) return root;
      appendHtmlText(stack.at(-1), source.slice(cursor, end));
      cursor = end;
      continue;
    }
    if (source.startsWith('<!--', cursor)) {
      if (!consumeToken()) return root;
      const end = source.indexOf('-->', cursor + 4);
      cursor = end < 0 ? source.length : end + 3;
      continue;
    }
    const closing = parseHtmlClosingTag(source, cursor);
    if (closing) {
      if (!consumeToken()) return root;
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].name === closing.name) {
          stack.length = index;
          break;
        }
      }
      cursor = closing.end;
      continue;
    }
    const opening = parseHtmlOpeningTag(source, cursor);
    if (opening?.invalid) {
      root.malformed = true;
      return root;
    }
    if (opening) {
      if (!consumeToken()) return root;
      // `stack` includes the document root, so it also bounds a void element
      // that is about to become one level deeper than the active parent.
      if (stack.length > MAX_GODOT_HTML_ELEMENT_DEPTH) {
        root.malformed = true;
        return root;
      }
      // In text/html, the slash in a non-void `<div/>`/`<template/>` is not
      // a self-closing marker.  Treat it as an ordinary start tag so its
      // following content remains in that element (and raw text consumes to
      // EOF when it has no real closing tag).
      const node = {
        type: 'element',
        ...opening,
        selfClosing: opening.selfClosing && VOID_HTML_ELEMENTS.has(opening.name),
        children: [],
      };
      stack.at(-1).children.push(node);
      cursor = opening.end;
      if (RAW_TEXT_HTML_ELEMENTS.has(node.name) && !node.selfClosing) {
        cursor = inertElementEnd(source, cursor, node.name);
      } else if (node.name === 'plaintext' && !node.selfClosing) {
        cursor = source.length;
      } else if (!node.selfClosing && !VOID_HTML_ELEMENTS.has(node.name)) {
        stack.push(node);
      }
      continue;
    }
    if (source.startsWith('<!', cursor) || source.startsWith('<?', cursor)) {
      if (!consumeToken()) return root;
      cursor = skipHtmlMarkup(source, cursor + 2);
      continue;
    }
    if (!consumeToken()) return root;
    appendHtmlText(stack.at(-1), '<');
    cursor += 1;
  }
  return root;
}

function nodeAttribute(node, name) {
  return String(node?.attributes?.[String(name || '').toLowerCase()] || '');
}

function nodeClassTokens(node) {
  return nodeAttribute(node, 'class').toLowerCase().split(/\s+/).filter(Boolean);
}

function nodeHasClasses(node, expected) {
  const tokens = new Set(nodeClassTokens(node));
  return expected.every((token) => tokens.has(token));
}

function elementDescendants(node, predicate, result = []) {
  for (const child of node?.children || []) {
    if (child.type !== 'element') continue;
    // Template contents are parsed only to preserve quote/tag boundaries, but
    // are inert document fragments and never evidence for the requested page.
    if (child.name === 'template') continue;
    if (predicate(child)) result.push(child);
    elementDescendants(child, predicate, result);
  }
  return result;
}

function allElementDescendants(node, predicate, result = []) {
  for (const child of node?.children || []) {
    if (child.type !== 'element') continue;
    if (predicate(child)) result.push(child);
    allElementDescendants(child, predicate, result);
  }
  return result;
}

function directElementChildren(node, name) {
  return (node?.children || []).filter((child) => child.type === 'element' && child.name === name);
}

function trustedGodotBody(document) {
  if (document?.malformed) return null;
  const allBodies = allElementDescendants(document, (node) => node.name === 'body');
  const allHtml = allElementDescendants(document, (node) => node.name === 'html');
  if (allBodies.length !== 1 || allHtml.length > 1) return null;

  const rootBodies = directElementChildren(document, 'body');
  const rootHtml = directElementChildren(document, 'html');
  if (rootBodies.length === 1 && allHtml.length === 0) {
    return allBodies[0] === rootBodies[0] ? rootBodies[0] : null;
  }
  if (rootBodies.length || rootHtml.length !== 1 || allHtml[0] !== rootHtml[0]) return null;
  const htmlBodies = directElementChildren(rootHtml[0], 'body');
  return htmlBodies.length === 1 && allBodies[0] === htmlBodies[0] ? htmlBodies[0] : null;
}

function trustedTargetArticles(node, predicate, result = []) {
  for (const child of node?.children || []) {
    if (child.type !== 'element') continue;
    // Do not enter another article: a matching ID there belongs to a related
    // card, not the page post.  Any other non-allowlisted wrapper likewise
    // fails closed instead of approximating HTML5 special insertion modes.
    if (child.name === 'article') {
      if (predicate(child)) result.push(child);
      continue;
    }
    if (!TRUSTED_TARGET_ANCESTOR_ELEMENTS.has(child.name)) continue;
    trustedTargetArticles(child, predicate, result);
  }
  return result;
}

function targetDescendants(targetArticle, predicate, result = []) {
  for (const child of targetArticle?.children || []) {
    if (child.type !== 'element') continue;
    // A related-work card may be nested inside the main article.  It is a
    // separate work, so neither it nor any of its descendants can be evidence.
    if (child.name === 'article' || child.name === 'template') continue;
    if (predicate(child)) result.push(child);
    targetDescendants(child, predicate, result);
  }
  return result;
}

function readableNodeText(node, maximum = MAX_METADATA_TEXT, excludedElements = INERT_EVIDENCE_ELEMENTS) {
  const pieces = [];
  const visit = (current) => {
    for (const child of current?.children || []) {
      if (child.type === 'text') pieces.push(child.value);
      else if (child.type === 'element' && !excludedElements.has(child.name)) visit(child);
    }
  };
  visit(node);
  return cleanText(pieces.join(' ')
    .replace(/&(?:nbsp|amp|quot|#39);/gi, ' ')
    .replace(/\s+/g, ' '), maximum);
}

function licenseBlockCandidates(targetArticle, trustedPath = true, result = []) {
  for (const child of targetArticle?.children || []) {
    if (child.type !== 'element') continue;
    // A nested article is a separate work card and cannot add or invalidate
    // this post's evidence.
    if (child.name === 'article') continue;
    if (nodeClassTokens(child).includes('shader_license_block')) {
      result.push({
        node: child,
        trusted: trustedPath && TRUSTED_LICENSE_BLOCK_ELEMENTS.has(child.name),
      });
    }
    licenseBlockCandidates(
      child,
      trustedPath && TRUSTED_LICENSE_BLOCK_WRAPPER_ELEMENTS.has(child.name),
      result,
    );
  }
  return result;
}

function strictLicenseBlockText(block) {
  let valid = true;
  const pieces = [];
  const visit = (current) => {
    for (const child of current?.children || []) {
      if (child.type === 'text') {
        pieces.push(child.value);
      } else if (child.type === 'element') {
        if (!TRUSTED_LICENSE_EVIDENCE_ELEMENTS.has(child.name)) {
          valid = false;
          continue;
        }
        visit(child);
      }
    }
  };
  visit(block);
  if (!valid) return null;
  return cleanText(pieces.join(' ')
    .replace(/&(?:nbsp|amp|quot|#39);/gi, ' ')
    .replace(/\s+/g, ' '), MAX_METADATA_TEXT);
}

function godotBodyPostId(body) {
  const candidates = new Set();
  for (const token of nodeClassTokens(body)) {
    const match = /^postid-(\d+)$/.exec(token);
    if (match) candidates.add(match[1]);
  }
  for (const attribute of ['data-post-id', 'data-postid']) {
    const value = nodeAttribute(body, attribute);
    if (/^\d+$/.test(value)) candidates.add(value);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

function targetGodotArticle(document) {
  const body = trustedGodotBody(document);
  if (!body) return { postId: null, article: null };
  const postId = godotBodyPostId(body);
  if (!postId) return { postId: null, article: null };
  const expectedId = `post-${postId}`;
  const articles = trustedTargetArticles(body, (node) => nodeAttribute(node, 'id') === expectedId);
  return { postId, article: articles.length === 1 ? articles[0] : null };
}

const GODOT_BLOCK_LICENSES = Object.freeze({
  'MIT License': 'MIT',
  'CC0 1.0': 'CC0-1.0',
  'CC0-1.0': 'CC0-1.0',
  'GPL v3': 'GPL-3.0-only',
  GPLv3: 'GPL-3.0-only',
  'GPL-3.0': 'GPL-3.0-only',
  'GPL-3.0-only': 'GPL-3.0-only',
});

function strictGodotBlockLicense(text) {
  return GODOT_BLOCK_LICENSES[text] || null;
}

const GODOT_CLASS_LICENSES = Object.freeze({
  'shader_license-mit': 'MIT',
  'shader_license-cc0': 'CC0-1.0',
  'shader_license-gpl': 'GPL-3.0-only',
  'shader_license-gpl3': 'GPL-3.0-only',
  'shader_license-gpl-3': 'GPL-3.0-only',
  'shader_license-gpl-v3': 'GPL-3.0-only',
  'shader_license-gpl-3-0': 'GPL-3.0-only',
  'shader_license-gpl-3-0-only': 'GPL-3.0-only',
});

function trustedGodotLicenseData(targetArticle) {
  const licenseBlockEvidence = [];
  const licenseBlockLicenses = new Set();
  let invalidLicenseBlock = false;
  if (!targetArticle) {
    return {
      hasLicenseBlock: false,
      invalidLicenseBlock,
      invalidArticleClass: false,
      licenseBlockLicenses: [],
      articleClassLicenses: [],
      licenseBlockEvidence,
      articleClassEvidence: [],
    };
  }
  const blocks = licenseBlockCandidates(targetArticle);
  for (const blockCandidate of blocks) {
    const evidence = blockCandidate.trusted ? strictLicenseBlockText(blockCandidate.node) : null;
    licenseBlockEvidence.push(evidence || '');
    const license = evidence ? strictGodotBlockLicense(evidence) : null;
    if (license) licenseBlockLicenses.add(license);
    else invalidLicenseBlock = true;
  }

  const articleClassEvidence = [];
  const articleClassLicenses = new Set();
  const licenseClasses = nodeClassTokens(targetArticle).filter((token) => token.startsWith('shader_license-'));
  const invalidArticleClass = licenseClasses.some((token) => !GODOT_CLASS_LICENSES[token]);
  for (const token of licenseClasses) {
    const license = GODOT_CLASS_LICENSES[token];
    if (license) articleClassLicenses.add(license);
  }
  if (licenseClasses.length) articleClassEvidence.push(`article class: ${licenseClasses.join(' ')}`);

  return {
    hasLicenseBlock: blocks.length > 0,
    invalidLicenseBlock,
    invalidArticleClass,
    licenseBlockLicenses: [...licenseBlockLicenses],
    articleClassLicenses: [...articleClassLicenses],
    licenseBlockEvidence,
    articleClassEvidence,
  };
}

function extractGodotAuthor(targetArticle) {
  const vcards = targetDescendants(targetArticle, (node) => node.name === 'span' && nodeHasClasses(node, ['author', 'vcard']));
  for (const vcard of vcards) {
    const authorLink = targetDescendants(vcard, (node) => node.name === 'a' && nodeHasClasses(node, ['url', 'fn', 'n']))[0];
    const author = readableNodeText(authorLink);
    if (author) return author;
  }
  const relAuthor = targetDescendants(targetArticle, (node) => node.name === 'a' && nodeAttribute(node, 'rel').toLowerCase().split(/\s+/).includes('author'))[0];
  return readableNodeText(relAuthor);
}

function godotMetaDescription(document) {
  const meta = elementDescendants(document, (node) => {
    if (node.name !== 'meta') return false;
    const semantic = nodeAttribute(node, 'name').toLowerCase() || nodeAttribute(node, 'property').toLowerCase();
    return semantic === 'description' || semantic === 'og:description';
  })[0];
  return cleanText(nodeAttribute(meta, 'content'));
}

export function extractGodotPageMetadata(html) {
  const document = parseGodotHtml(html);
  const target = targetGodotArticle(document);
  const license = trustedGodotLicenseData(target.article);
  const pageLicenses = new Set([...license.licenseBlockLicenses, ...license.articleClassLicenses]);
  const title = targetDescendants(target.article, (node) => node.name === 'h1')[0];
  return {
    postId: target.postId,
    title: readableNodeText(title, 4 * 1024),
    description: godotMetaDescription(document),
    author: extractGodotAuthor(target.article),
    pageLicenses: [...pageLicenses],
    licenseEvidence: [...license.licenseBlockEvidence, ...license.articleClassEvidence],
    hasLicenseBlock: license.hasLicenseBlock,
    invalidLicenseBlock: license.invalidLicenseBlock,
    invalidArticleClass: license.invalidArticleClass,
    licenseBlockLicenses: license.licenseBlockLicenses,
    articleClassLicenses: license.articleClassLicenses,
    licenseBlockEvidence: license.licenseBlockEvidence,
    articleClassEvidence: license.articleClassEvidence,
  };
}

export function getGodotSourcePolicy(page = {}, authorizationBasis, sourceCode = null) {
  const licenseBlockLicenses = new Set(page.licenseBlockLicenses || []);
  const articleClassLicenses = new Set(page.articleClassLicenses || []);
  const pageLicenses = new Set([...licenseBlockLicenses, ...articleClassLicenses]);
  const hasLicenseBlock = Boolean(page.hasLicenseBlock);
  const invalidLicenseBlock = Boolean(page.invalidLicenseBlock);
  const invalidArticleClass = Boolean(page.invalidArticleClass);
  const hasSingleStrictBlock = hasLicenseBlock && !invalidLicenseBlock && licenseBlockLicenses.size === 1;
  const hasSingleStrictClass = !invalidArticleClass && articleClassLicenses.size === 1;
  const pageAuthority = hasLicenseBlock ? hasSingleStrictBlock : hasSingleStrictClass;
  const pageConflict = !pageAuthority
    || invalidArticleClass
    || articleClassLicenses.size > 1
    || (licenseBlockLicenses.size === 1 && articleClassLicenses.size === 1
      && [...licenseBlockLicenses][0] !== [...articleClassLicenses][0]);
  // A strict scoped block is authoritative when present: an invalid one cannot
  // be overridden by CSS.  Some real Godot pages (including Bamboo) expose
  // only one exact platform license class, which is the allowed fallback.
  const pageSpdx = !pageConflict
    ? hasLicenseBlock ? [...licenseBlockLicenses][0] : [...articleClassLicenses][0]
    : null;
  const pageLicenseEligible = pageSpdx === 'CC0-1.0' || pageSpdx === 'MIT' || pageSpdx === 'GPL-3.0-only';
  const callerAllowsSource = ['licensed', 'user-owned', 'author-permission'].includes(authorizationBasis);
  const sourceFetched = sourceCode !== null;
  const sourceHeader = sourceFetched
    ? sourceHeaderLicenseDeclaration(sourceCode)
    : { licenses: new Set(), evidence: '', declared: false, unrecognized: false, truncated: false };
  const sourceHeaderLicenses = sourceHeader.licenses;
  const conflict = pageConflict
    || sourceHeaderLicenses.size > 1
    || sourceHeader.unrecognized
    || (pageLicenses.size === 1 && sourceHeaderLicenses.size === 1
      && [...pageLicenses][0] !== [...sourceHeaderLicenses][0]);
  const sourceSpdx = sourceHeaderLicenses.size === 1 && !sourceHeader.unrecognized
    ? [...sourceHeaderLicenses][0]
    : null;
  // A page declaration permits an authorized cross-check request, but never
  // substitutes for the shader's own leading license declaration.  Caching
  // requires exactly one supported source-header license that agrees with the
  // one scoped page license; an absent or author-only header is review-only.
  const explicitCacheLicense = Boolean(sourceFetched
    && pageLicenseEligible
    && sourceSpdx
    && sourceSpdx === pageSpdx
    && !conflict);
  const spdx = explicitCacheLicense ? pageSpdx : null;
  // The page's scoped declaration is the minimum authority needed to read a
  // user-work source endpoint. A source header can still veto caching after
  // it is retrieved and cross-checked.
  const canFetchSource = callerAllowsSource && pageLicenseEligible;
  const cacheAllowed = sourceFetched && callerAllowsSource && explicitCacheLicense;
  const copyleft = explicitCacheLicense && spdx === 'GPL-3.0-only';
  return {
    licenseBlockLicenses,
    articleClassLicenses,
    pageLicenses,
    hasLicenseBlock,
    invalidLicenseBlock,
    invalidArticleClass,
    hasSingleStrictBlock,
    hasSingleStrictClass,
    pageConflict,
    pageLicenseEligible,
    sourceHeaderLicenses,
    sourceHeaderEvidence: sourceHeader.evidence,
    sourceHeaderDeclared: sourceHeader.declared,
    sourceHeaderUnrecognized: sourceHeader.unrecognized,
    sourceHeaderTruncated: sourceHeader.truncated,
    conflict,
    spdx,
    explicitCacheLicense,
    callerAllowsSource,
    canFetchSource,
    cacheAllowed,
    copyleft,
  };
}

export function normalizeGodotResource({ resolved, page, apiPayload, authorizationBasis, now }) {
  const sourceFetched = apiPayload !== null && apiPayload !== undefined;
  let code = '';
  if (sourceFetched) {
    code = typeof apiPayload?.code === 'string' ? apiPayload.code : '';
    if (!code) {
      throw new Error('The Godot Shaders source endpoint returned no code text.');
    }
    const apiId = String(apiPayload?.id ?? '');
    if (!/^\d+$/.test(apiId) || apiId !== page.postId) {
      throw new Error('The Godot Shaders source endpoint did not match the page post id.');
    }
  }
  const policy = getGodotSourcePolicy(page, authorizationBasis, sourceFetched ? code : null);
  if (policy.canFetchSource && !sourceFetched) {
    throw new Error('A permitted Godot Shaders source import requires the matching source endpoint response.');
  }
  if (sourceFetched && !policy.canFetchSource) {
    throw new Error('Godot Shaders source must not be requested without both a permitted caller authorization and an unambiguous scoped page license.');
  }
  const parsedShaderType = /\bshader_type\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/.exec(code)?.[1] || null;
  const apiShaderType = cleanText(String(apiPayload?.shader_type || ''), 256) || null;
  const metadataConflict = Boolean(apiShaderType && parsedShaderType && apiShaderType !== parsedShaderType);
  const licenseEvidence = [
    ...(page.licenseBlockEvidence || []).map((text) => ({ kind: 'shader-license-block', text })),
    ...(page.articleClassEvidence || []).map((text) => ({ kind: 'article-license-class', text })),
    ...(sourceFetched && policy.sourceHeaderEvidence ? [{ kind: 'source-header-license', text: policy.sourceHeaderEvidence }] : []),
  ];
  const rights = !sourceFetched
    ? reviewRights(
      policy.pageLicenseEligible
        ? 'The scoped Godot page license was not cross-checked against a leading source-license declaration.'
        : policy.pageConflict
          ? 'Conflicting Godot Shader page license declarations.'
          : 'No unambiguous scoped Godot Shader page license was found.',
      licenseEvidence,
    )
    : policy.explicitCacheLicense
    ? classifiedRights(policy.spdx, [
      ...licenseEvidence,
    ], {
      status: policy.copyleft ? 'copyleft_review' : 'classified',
      reviewRequired: policy.copyleft,
      adaptation: policy.copyleft ? 'allowed-with-copyleft' : 'allowed',
      commercial: 'verify-upstream-terms',
    })
    : reviewRights(
      policy.conflict
        ? 'Conflicting Godot Shader license declarations.'
        : 'No unambiguous Godot Shader license was found after source-header review.',
      licenseEvidence,
    );
  const title = cleanText(typeof apiPayload?.title === 'string' ? apiPayload.title : page.title, 4 * 1024)
    || resolved.ref.id;
  return {
    ref: resolved.ref,
    kind: 'shader',
    title,
    author: page.author,
    description: page.description,
    tags: ['godot', apiShaderType || parsedShaderType || 'shader'],
    language: 'godot-shader',
    canonicalUrl: resolved.canonicalUrl,
    rights,
    provenance: {
      acquisition: 'user-provided-canonical-link',
      pagePostId: page.postId,
      ...(sourceFetched ? { apiEndpoint: `/wp-json/shader_data/shader/${page.postId}` } : {}),
      sourceEndpointFetched: sourceFetched,
      fetchedAt: isoNow(now),
    },
    authorization: authorizationBasis ? { basis: authorizationBasis, assertedBy: 'caller' } : null,
    contentPolicy: policy.cacheAllowed ? 'full_source' : 'metadata_only',
    metadata: {
      pageLicense: [...policy.pageLicenses],
      licenseBlockLicense: [...policy.licenseBlockLicenses],
      articleClassLicense: [...policy.articleClassLicenses],
      hasLicenseBlock: policy.hasLicenseBlock,
      invalidLicenseBlock: policy.invalidLicenseBlock,
      invalidArticleClass: policy.invalidArticleClass,
      sourceHeaderLicense: [...policy.sourceHeaderLicenses],
      sourceHeaderDeclared: policy.sourceHeaderDeclared,
      sourceHeaderUnrecognized: policy.sourceHeaderUnrecognized,
      sourceHeaderTruncated: policy.sourceHeaderTruncated,
      sourceHeaderChecked: sourceFetched,
      licenseConflict: policy.conflict,
      cacheAllowedByLicense: policy.explicitCacheLicense,
      cacheAllowedByAuthorization: policy.callerAllowsSource,
      sourceCrossCheckPending: !sourceFetched && policy.pageLicenseEligible,
      sourceFetched,
      sourceCached: policy.cacheAllowed,
      copyleftReview: policy.copyleft,
      apiShaderType,
      parsedShaderType,
      metadataConflict,
      externalAssetsDownloaded: false,
      externalAssetRequired: sourceFetched ? /\b(?:sampler2D|texture\s*\(|SCREEN_TEXTURE|DEPTH_TEXTURE)\b/.test(code) : null,
    },
    blobs: policy.cacheAllowed ? [{ role: 'shader', mimeType: 'text/x-godot-shader', body: code }] : [],
  };
}

export const BOOK_OF_SHADERS_TOPICS = Object.freeze([
  ['chapter-00', '着色器基础', '从片元坐标、颜色到 uniform 的入门路线。', 'https://thebookofshaders.com/00/?lan=ch', 'zh-CN', ['基础', '坐标', 'uniform']],
  ['chapter-07', '形状、矩阵与图案', '使用距离、变换和重复建立二维图案。', 'https://thebookofshaders.com/07/?lan=ch', 'zh-CN', ['形状', '矩阵', '图案']],
  ['chapter-10', '随机、噪声与 cellular/fBm', '比较伪随机、连续噪声、细胞噪声与分形叠加。', 'https://thebookofshaders.com/10/?lan=ch', 'zh-CN', ['随机', '噪声', 'cellular', 'fBm']],
  ['chapter-13', '纹理与卷积', '把采样、滤波和邻域运算视为可移植算法主题。', 'https://thebookofshaders.com/13/?lan=ch', 'zh-CN', ['纹理', '卷积', '采样']],
  ['chapter-18', '模拟', '将状态更新、反馈和时间步长作为效果拆解线索。', 'https://thebookofshaders.com/18/?lan=en', 'en', ['模拟', '反馈', '时间']],
  ['chapter-16', '光照与光线步进', '以光照、距离场和步进为学习索引，而非复制页面代码。', 'https://thebookofshaders.com/16/?lan=en', 'en', ['光照', 'raymarching', 'SDF']],
]);

export function normalizeBookOfShadersTopic(topic, resolved, now) {
  const [, title, description, canonicalUrl, sourceLanguage, tags] = topic;
  return {
    ref: resolved?.ref || { provider: 'book-of-shaders', id: topic[0] },
    kind: 'knowledge',
    title,
    description,
    tags,
    language: 'zh-CN',
    canonicalUrl: resolved?.canonicalUrl || canonicalUrl,
    rights: reviewRights('The Book of Shaders is a reference-only source; page text and code are not cached.'),
    provenance: { acquisition: 'built-in-original-topic-index', fetchedAt: isoNow(now) },
    authorization: { basis: 'reference-only', assertedBy: 'built-in-provider-policy' },
    contentPolicy: 'link_only',
    metadata: {
      referenceOnly: true,
      bodyBytes: 0,
      sourcePageFetched: false,
      topicId: topic[0],
      summaryLanguage: 'zh-CN',
      sourceLanguage: sourceLanguage || 'zh-CN',
    },
    blobs: [],
  };
}
