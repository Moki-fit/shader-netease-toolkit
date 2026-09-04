/**
 * License labels are useful routing information, not legal conclusions.
 *
 * Shadertoy payloads are not completely uniform: older records can contain a
 * short SPDX id while newer or imported records may contain a display name or
 * free-form notice.  This module intentionally recognises only a small,
 * explicit set of common licenses and leaves everything else as custom.
 */

export const LICENSE_DISCLAIMER =
  'License classification is a best-effort metadata aid, not legal advice. Verify the original license text and obtain legal advice when needed.';

// Keep source-header inspection bounded even when a caller supplied a legal
// (but unusually large) shader source.  The database also enforces the larger
// 2 MiB source limit before it reaches this helper.
export const MAX_LICENSE_HEADER_BYTES = 16 * 1024;

const DEFAULT_SHADERTOY_LICENSE = {
  spdx: 'CC-BY-NC-SA-3.0',
  name: 'Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported',
  commercial: 'restricted',
  adaptation: 'allowed-with-share-alike',
  attribution: 'required',
  shareAlike: true,
};

function definition(spdx, name, commercial, adaptation, attribution = 'required', shareAlike = false) {
  return { spdx, name, commercial, adaptation, attribution, shareAlike };
}

const LICENSE_DEFINITIONS = Object.freeze({
  'CC0-1.0': definition('CC0-1.0', 'Creative Commons Zero v1.0 Universal', 'allowed', 'allowed', 'not-required'),
  'CC-BY-3.0': definition('CC-BY-3.0', 'Creative Commons Attribution 3.0', 'allowed', 'allowed'),
  'CC-BY-4.0': definition('CC-BY-4.0', 'Creative Commons Attribution 4.0 International', 'allowed', 'allowed'),
  'CC-BY-SA-3.0': definition('CC-BY-SA-3.0', 'Creative Commons Attribution-ShareAlike 3.0', 'allowed', 'allowed-with-share-alike', 'required', true),
  'CC-BY-SA-4.0': definition('CC-BY-SA-4.0', 'Creative Commons Attribution-ShareAlike 4.0 International', 'allowed', 'allowed-with-share-alike', 'required', true),
  'CC-BY-ND-3.0': definition('CC-BY-ND-3.0', 'Creative Commons Attribution-NoDerivatives 3.0', 'allowed', 'restricted'),
  'CC-BY-ND-4.0': definition('CC-BY-ND-4.0', 'Creative Commons Attribution-NoDerivatives 4.0 International', 'allowed', 'restricted'),
  'CC-BY-NC-3.0': definition('CC-BY-NC-3.0', 'Creative Commons Attribution-NonCommercial 3.0', 'restricted', 'allowed'),
  'CC-BY-NC-4.0': definition('CC-BY-NC-4.0', 'Creative Commons Attribution-NonCommercial 4.0 International', 'restricted', 'allowed'),
  'CC-BY-NC-SA-3.0': definition('CC-BY-NC-SA-3.0', 'Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported', 'restricted', 'allowed-with-share-alike', 'required', true),
  'CC-BY-NC-SA-4.0': definition('CC-BY-NC-SA-4.0', 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International', 'restricted', 'allowed-with-share-alike', 'required', true),
  'CC-BY-NC-ND-3.0': definition('CC-BY-NC-ND-3.0', 'Creative Commons Attribution-NonCommercial-NoDerivatives 3.0', 'restricted', 'restricted'),
  'CC-BY-NC-ND-4.0': definition('CC-BY-NC-ND-4.0', 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International', 'restricted', 'restricted'),
  MIT: definition('MIT', 'MIT License', 'allowed', 'allowed'),
  'Apache-2.0': definition('Apache-2.0', 'Apache License 2.0', 'allowed', 'allowed'),
  'BSD-2-Clause': definition('BSD-2-Clause', 'BSD 2-Clause License', 'allowed', 'allowed'),
  'BSD-3-Clause': definition('BSD-3-Clause', 'BSD 3-Clause License', 'allowed', 'allowed'),
  BSD: definition('BSD', 'BSD-style license', 'allowed', 'allowed'),
  'GPL-2.0-only': definition('GPL-2.0-only', 'GNU General Public License v2.0 only', 'allowed', 'allowed-with-copyleft', 'required', true),
  'GPL-2.0-or-later': definition('GPL-2.0-or-later', 'GNU General Public License v2.0 or later', 'allowed', 'allowed-with-copyleft', 'required', true),
  'GPL-3.0-only': definition('GPL-3.0-only', 'GNU General Public License v3.0 only', 'allowed', 'allowed-with-copyleft', 'required', true),
  'GPL-3.0-or-later': definition('GPL-3.0-or-later', 'GNU General Public License v3.0 or later', 'allowed', 'allowed-with-copyleft', 'required', true),
});

const LICENSE_TEXT_KEYS = ['spdx', 'spdxId', 'identifier', 'id', 'name', 'title', 'text', 'license'];

function licenseTexts(value) {
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const texts = [];
  for (const key of LICENSE_TEXT_KEYS) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      texts.push(value[key].trim());
    }
  }
  return [...new Set(texts)];
}

function textFromLicense(value) {
  return licenseTexts(value).join('\n');
}

export function hasLicenseDeclaration(value) {
  return licenseTexts(value).length > 0;
}

function evidenceText(text) {
  return text.length > 512 ? `${text.slice(0, 509)}...` : text;
}

function resultFromKnown(known, text, source, match = known.spdx) {
  return {
    spdx: known.spdx,
    identifier: known.spdx,
    name: known.name,
    source,
    evidence: [
      {
        kind: source === 'default' ? 'default-policy' : 'declared-license',
        text: evidenceText(text),
        match,
      },
    ],
    commercial: known.commercial,
    adaptation: known.adaptation,
    attribution: known.attribution,
    shareAlike: known.shareAlike,
    review: false,
    status: source === 'default' ? 'default' : 'classified',
    disclaimer: LICENSE_DISCLAIMER,
  };
}

function reviewResult({ spdx = 'LicenseRef-Unrecognized', name, source = 'declared', text, evidence, conflicts = [], licenses = [] }) {
  return {
    spdx,
    identifier: spdx,
    name: name || 'Unrecognised or review-required license declaration',
    source,
    evidence: evidence?.length ? evidence : [{ kind: 'declared-license', text: evidenceText(text || ''), match: 'review-required' }],
    commercial: 'unknown',
    adaptation: 'unknown',
    attribution: 'unknown',
    shareAlike: false,
    review: true,
    status: 'review',
    conflicts,
    licenses,
    disclaimer: LICENSE_DISCLAIMER,
  };
}

function addMatch(matches, spdx, match) {
  if (LICENSE_DEFINITIONS[spdx] && !matches.has(spdx)) {
    matches.set(spdx, match);
  }
}

function findCreativeCommonsMatches(text, matches) {
  const compact = text.toUpperCase().replace(/[\s_]+/g, '-').replace(/-{2,}/g, '-');
  const direct = /\b(CC0(?:-1\.0)?|CC-BY(?:-NC)?(?:-(?:SA|ND))?-(?:3\.0|4\.0))\b/g;
  for (let match = direct.exec(compact); match; match = direct.exec(compact)) {
    const spdx = match[1] === 'CC0' ? 'CC0-1.0' : match[1];
    addMatch(matches, spdx, match[1]);
  }
  const lower = text.toLowerCase();
  if (/creative\s+commons\s+zero/.test(lower)) {
    addMatch(matches, 'CC0-1.0', 'Creative Commons Zero');
    return;
  }
  if (!/creative\s+commons\s+attribution/.test(lower)) {
    return;
  }
  const suffix = `${/(?:noncommercial|non-commercial)/.test(lower) ? '-NC' : ''}${/(?:sharealike|share-alike)/.test(lower) ? '-SA' : /(?:noderivatives|no-derivatives)/.test(lower) ? '-ND' : ''}`;
  const version = /\b([34])(?:\.0)?\b/.exec(lower)?.[1];
  if (version) {
    addMatch(matches, `CC-BY${suffix}-${version}.0`, `Creative Commons Attribution${suffix} ${version}.0`);
  } else if (suffix === '-NC-SA') {
    // Shadertoy's historical unversioned default label denotes 3.0. Do not
    // use this fallback for other CC variants, where the version matters.
    addMatch(matches, 'CC-BY-NC-SA-3.0', 'Creative Commons Attribution-NonCommercial-ShareAlike');
  }
}

function findKnownLicenses(text) {
  const matches = new Map();
  findCreativeCommonsMatches(text, matches);
  const patterns = [
    ['MIT', /\bmit(?:\s+license)?\b/i],
    ['Apache-2.0', /\bapache(?:\s+license)?\s*(?:version\s*)?2(?:\.0)?\b|\bapache[-\s]?2\.0\b/i],
    ['BSD-3-Clause', /\bbsd[-\s]?3[-\s]?(?:clause)?\b|\b3[-\s]?clause\s+bsd\b/i],
    ['BSD-2-Clause', /\bbsd[-\s]?2[-\s]?(?:clause)?\b|\b2[-\s]?clause\s+bsd\b|\bsimplified\s+bsd\b/i],
    ['BSD', /\bbsd(?:\s+license)?\b(?![-\s]?(?:2|3)(?:[-\s]?clause)?\b)/i],
    ['GPL-3.0-or-later', /\b(?:gpl[-\s]?3(?:\.0)?[-\s]?or[-\s]?later|gnu\s+general\s+public\s+license\s*(?:v(?:ersion)?\s*)?3(?:\.0)?\s+or\s+later)\b/i],
    ['GPL-2.0-or-later', /\b(?:gpl[-\s]?2(?:\.0)?[-\s]?or[-\s]?later|gnu\s+general\s+public\s+license\s*(?:v(?:ersion)?\s*)?2(?:\.0)?\s+or\s+later)\b/i],
    ['GPL-3.0-only', /\b(?:(?:gnu\s+)?gpl[-\s]?(?:v)?3(?:\.0)?(?![.\d])(?:[-\s]?only)?|gnu\s+general\s+public\s+license\s*(?:v(?:ersion)?\s*)?3(?:\.0)?(?![.\d])(?:\s+only)?)\b(?![-\s]+or[-\s]+later)/i],
    ['GPL-2.0-only', /\b(?:(?:gnu\s+)?gpl[-\s]?(?:v)?2(?:\.0)?(?![.\d])(?:[-\s]?only)?|gnu\s+general\s+public\s+license\s*(?:v(?:ersion)?\s*)?2(?:\.0)?(?![.\d])(?:\s+only)?)\b(?![-\s]+or[-\s]+later)/i],
  ];
  for (const [spdx, pattern] of patterns) {
    const match = pattern.exec(text);
    if (match) {
      addMatch(matches, spdx, match[0]);
    }
  }
  return [...matches.entries()].map(([spdx, match]) => ({ known: LICENSE_DEFINITIONS[spdx], match }));
}

/**
 * Classify a declared license string without claiming to interpret legal terms.
 * An absent declaration deliberately falls back to Shadertoy's historical
 * default CC-BY-NC-SA-3.0 metadata. Explicit but unsupported, composite, or
 * conflicting declarations remain review-required instead of falling back.
 */
export function detectLicense(declaration) {
  const text = textFromLicense(declaration);
  if (!text) {
    return resultFromKnown(
      DEFAULT_SHADERTOY_LICENSE,
      'No project-specific license declaration was supplied; using the Shadertoy default CC-BY-NC-SA-3.0 classification.',
      'default',
      'Shadertoy default',
    );
  }

  const known = findKnownLicenses(text);
  const allRightsReserved = /\ball\s+rights\s+reserved\b/i.test(text);
  if (known.length === 1 && !allRightsReserved) {
    return resultFromKnown(known[0].known, text, 'declared', known[0].match);
  }
  if (known.length > 1 || (known.length && allRightsReserved)) {
    const licenses = known.map(({ known: item }) => ({ spdx: item.spdx, name: item.name }));
    const conflicts = [...licenses.map((item) => item.spdx), ...(allRightsReserved ? ['all-rights-reserved'] : [])];
    return reviewResult({
      spdx: 'LicenseRef-Composite',
      name: 'Composite or conflicting license declaration',
      text,
      conflicts,
      licenses,
    });
  }
  return reviewResult({
    spdx: allRightsReserved ? 'LicenseRef-All-Rights-Reserved' : 'LicenseRef-Unrecognized',
    name: allRightsReserved ? 'All rights reserved / custom license' : 'Unrecognised license declaration',
    text,
  });
}

/**
 * Merge independently located declarations without concealing a disagreement.
 * This is used for metadata fields and for pass-header declarations.
 */
export function combineLicenseResults(results, source = undefined) {
  const values = results.filter((value) => value && typeof value === 'object');
  if (!values.length) {
    return null;
  }
  if (values.length === 1) {
    return { ...values[0], source: source ?? values[0].source };
  }
  const evidence = values.flatMap((value) => Array.isArray(value.evidence) ? value.evidence : []);
  const unique = new Map();
  for (const value of values) {
    const reviewEvidence = value.review
      ? (value.evidence ?? []).map((entry) => `${entry.match ?? ''}\u0000${entry.text ?? ''}`).join('\u0001')
      : '';
    const key = `${value.spdx}\u0000${value.review ? 'review' : 'classified'}\u0000${reviewEvidence}`;
    if (!unique.has(key)) {
      unique.set(key, value);
    }
  }
  if (unique.size === 1) {
    const [first] = unique.values();
    return { ...first, evidence, source: source ?? first.source };
  }
  const licenses = [...unique.values()].map((value) => ({ spdx: value.spdx, name: value.name, source: value.source }));
  return reviewResult({
    spdx: 'LicenseRef-Conflict',
    name: 'Conflicting or unresolved license declarations',
    source: source ?? 'declared',
    evidence,
    conflicts: licenses.map((value) => value.spdx),
    licenses,
  });
}

function boundedUtf8Prefix(source) {
  if (typeof source !== 'string' || !source) {
    return '';
  }
  const bytes = Buffer.from(source, 'utf8');
  return bytes.subarray(0, Math.min(bytes.length, MAX_LICENSE_HEADER_BYTES)).toString('utf8');
}

/**
 * Return only comments in the leading shader header.  Once ordinary GLSL
 * tokens start, later comments are source-body content and deliberately do
 * not participate in license inference.  `#version`/`#extension`/`#pragma`
 * are permitted in the header because engines commonly place them before a
 * comment banner.
 */
function leadingHeaderComments(source) {
  const prefix = boundedUtf8Prefix(source);
  const comments = [];
  let index = prefix.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < prefix.length) {
    while (index < prefix.length && /\s/.test(prefix[index])) {
      index += 1;
    }
    if (prefix.startsWith('//', index)) {
      const end = prefix.indexOf('\n', index + 2);
      comments.push(prefix.slice(index + 2, end < 0 ? prefix.length : end));
      index = end < 0 ? prefix.length : end + 1;
      continue;
    }
    if (prefix.startsWith('/*', index)) {
      const end = prefix.indexOf('*/', index + 2);
      if (end < 0) {
        // An unfinished leading comment cannot safely be assumed to be a
        // header; stop rather than scanning arbitrary remainder text.
        break;
      }
      comments.push(prefix.slice(index + 2, end));
      index = end + 2;
      continue;
    }
    if (prefix[index] === '#') {
      const end = prefix.indexOf('\n', index + 1);
      const directive = prefix.slice(index, end < 0 ? prefix.length : end);
      if (/^\s*#\s*(?:version|extension|pragma)\b/i.test(directive)) {
        index = end < 0 ? prefix.length : end + 1;
        continue;
      }
    }
    break;
  }
  return comments.join('\n');
}

function headerLicenseCandidate(header) {
  const spdx = /\bSPDX-License-Identifier\s*:\s*([A-Za-z0-9.+-]+(?:\s+(?:OR|AND)\s+[A-Za-z0-9.+-]+)*)/i.exec(header);
  if (spdx) {
    return { kind: 'source-header-spdx', declaration: spdx[1].trim(), evidence: spdx[0].trim() };
  }

  for (const line of header.split(/\r?\n/)) {
    const text = line.replace(/^\s*\*?\s*/, '').trim();
    const match = /^(?:@license|license(?:\s+identifier)?)\s*[:=]\s*(.+)$|^(?:licensed\s+under|released\s+under)\s+(.+)$/i.exec(text);
    if (!match) {
      // Support terse but recognisable banners such as `@license MIT` while
      // rejecting generic prose like `license information follows`.
      const terse = /^(?:@license|license)\s+(.+)$/i.exec(text);
      if (!terse || !/\b(?:mit|apache|bsd|gpl|cc0|mpl|creative\s+commons)\b|\bcc[-\s]?by\b|\ball\s+rights\s+reserved\b/i.test(terse[1])) {
        continue;
      }
      return { kind: 'source-header-license', declaration: terse[1].trim(), evidence: text };
    }
    const declaration = (match[1] ?? match[2]).trim();
    // `License:` and `Licensed under` are explicit declarations even when
    // this scanner does not recognise the named license (for example MPL).
    // Those must become review-required rather than silently using a default.
    return { kind: 'source-header-license', declaration, evidence: text };
  }
  return null;
}

/**
 * Detect an SPDX or common-license declaration in a leading GLSL comment
 * banner. Returns `null` when there is no explicit header declaration so
 * callers can apply their own metadata/default precedence.
 */
export function detectLicenseFromSourceHeader(source) {
  const candidate = headerLicenseCandidate(leadingHeaderComments(source));
  if (!candidate) {
    return null;
  }
  const result = detectLicense(candidate.declaration);
  return {
    ...result,
    source: 'source-header',
    evidence: [
      {
        kind: candidate.kind,
        text: evidenceText(candidate.evidence),
        match: candidate.declaration,
      },
    ],
  };
}

export const detectSourceHeaderLicense = detectLicenseFromSourceHeader;

export const DEFAULT_LICENSE = Object.freeze(detectLicense());
