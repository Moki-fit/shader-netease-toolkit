/**
 * Conservative Shadertoy / GLSL source inventory.
 *
 * This is deliberately a text scanner.  It does not parse all GLSL grammar,
 * compile, link, load, or execute source in Shadertoy, NetEase Minecraft, a
 * GPU driver, or MCDK.  A missing finding is not proof of compatibility.
 */

export const ANALYZER_VERSION = 1;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const ANALYSIS_DISCLAIMER =
  'Conservative text-level source analysis only. It did not compile, link, load, or run this shader in Shadertoy, NetEase Minecraft, MCDK, or a GPU runtime.';

const SHADERTOY_UNIFORMS = [
  'iResolution',
  'iTime',
  'iTimeDelta',
  'iFrame',
  'iFrameRate',
  'iMouse',
  'iDate',
  'iSampleRate',
  'iChannelTime',
  'iChannelResolution',
  'iChannel0',
  'iChannel1',
  'iChannel2',
  'iChannel3',
];

const MAX_FINDINGS_PER_RULE = 8;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function firstIdentifier(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

function numberOr(fallback, ...values) {
  for (const value of values) {
    if (Number.isFinite(value)) {
      return Number(value);
    }
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return fallback;
}

function arrayFrom(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === 'object') {
    for (const key of ['Results', 'results', 'items', 'data']) {
      if (Array.isArray(value[key])) {
        return value[key];
      }
    }
  }
  return [];
}

function sourceFromPass(pass) {
  const value = pass.code ?? pass.Code ?? pass.sourceCode ?? pass.source ?? '';
  return typeof value === 'string' ? value : '';
}

function inputsFromPass(pass) {
  return arrayFrom(pass.inputs ?? pass.Inputs);
}

function outputsFromPass(pass) {
  return arrayFrom(pass.outputs ?? pass.Outputs);
}

function rawPasses(project) {
  const direct = asObject(project);
  const root = asObject(direct.Shader ?? direct.shader ?? direct.project ?? direct);
  return arrayFrom(
    root.renderpasses ??
      root.renderpass ??
      root.renderPasses ??
      root.passes ??
      direct.renderpasses ??
      direct.renderpass ??
      direct.renderPasses ??
      direct.passes,
  );
}

function rawInfo(project) {
  const direct = asObject(project);
  const root = asObject(direct.Shader ?? direct.shader ?? direct.project ?? direct);
  return asObject(root.info ?? root.Info ?? direct.info ?? direct.Info);
}

function canonicalPassName(pass, index) {
  const name = firstString(pass.name, pass.Name, pass.passName, pass.label);
  if (name) {
    return name;
  }
  const type = firstString(pass.type, pass.Type).toLowerCase();
  if (type === 'image') {
    return 'Image';
  }
  if (type === 'common') {
    return 'Common';
  }
  if (type === 'buffer') {
    return `Buffer ${String.fromCharCode(65 + Math.min(index, 25))}`;
  }
  return `Pass ${index + 1}`;
}

function canonicalPassType(pass, name) {
  const explicit = firstString(pass.type, pass.Type).toLowerCase();
  if (explicit) {
    return explicit;
  }
  const normalizedName = name.toLowerCase().replace(/\s+/g, '');
  if (normalizedName === 'image') {
    return 'image';
  }
  if (normalizedName === 'common') {
    return 'common';
  }
  if (/^buffer[a-d]$/.test(normalizedName)) {
    return 'buffer';
  }
  return 'unknown';
}

/**
 * Turn either a canonical API object or an official Shadertoy payload into a
 * small, predictable representation.  Unknown input/output fields remain in
 * their original object and are only stored as metadata by the database.
 */
export function normalizeProject(project) {
  const direct = asObject(project);
  const root = asObject(direct.Shader ?? direct.shader ?? direct.project ?? direct);
  const info = rawInfo(project);
  const tagsValue = direct.tags ?? root.tags ?? info.tags ?? info.Tags ?? [];
  const tags = Array.isArray(tagsValue)
    ? tagsValue.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
    : typeof tagsValue === 'string'
      ? tagsValue.split(/[;,]/).map((tag) => tag.trim()).filter(Boolean)
      : [];
  const normalizedPasses = rawPasses(project).map((raw, arrayIndex) => {
    const pass = asObject(raw);
    const index = numberOr(arrayIndex, pass.index, pass.Index, pass.order);
    const name = canonicalPassName(pass, index);
    return {
      index,
      id: firstIdentifier(pass.id, pass.ID, pass.passId, pass.uuid),
      name,
      type: canonicalPassType(pass, name),
      description: firstString(pass.description, pass.Description),
      code: sourceFromPass(pass),
      inputs: inputsFromPass(pass),
      outputs: outputsFromPass(pass),
    };
  });

  const id = firstString(
    direct.id,
    direct.shaderId,
    direct.shader_id,
    root.id,
    root.shaderId,
    root.shader_id,
    info.id,
    info.ID,
  );
  return {
    id,
    title: firstString(direct.title, root.title, root.name, info.name, info.title, info.Name),
    author: firstString(direct.author, root.author, info.username, info.author, info.userName),
    description: firstString(direct.description, root.description, info.description),
    tags,
    publishedAt: firstString(direct.publishedAt, root.publishedAt, info.date, info.published),
    updatedAt: firstString(direct.updatedAt, root.updatedAt, info.updated, info.modified),
    viewed: numberOr(0, direct.viewed, root.viewed, info.viewed, info.views),
    likes: numberOr(0, direct.likes, root.likes, info.likes),
    source: asObject(direct.source ?? root.source),
    license: direct.license ?? root.license ?? info.license ?? info.License,
    renderpasses: normalizedPasses,
  };
}

/**
 * Enforce a source-text boundary before persistence or analysis.  The limit
 * applies both to an individual pass and to all pass text in one project so a
 * many-pass payload cannot bypass the same memory budget.
 */
export function assertProjectSourceSize(project) {
  const normalized = normalizeProject(project);
  let totalBytes = 0;
  for (const pass of normalized.renderpasses) {
    const bytes = Buffer.byteLength(pass.code, 'utf8');
    if (bytes > MAX_SOURCE_BYTES) {
      throw new RangeError(
        `Pass ${pass.name} source is ${bytes} bytes; the maximum is ${MAX_SOURCE_BYTES} bytes.`,
      );
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_SOURCE_BYTES) {
    throw new RangeError(
      `Project source is ${totalBytes} bytes; the maximum is ${MAX_SOURCE_BYTES} bytes.`,
    );
  }
  return totalBytes;
}

function stripComments(source) {
  const output = [];
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1] ?? '';
    if (state === 'code') {
      if (character === '/' && next === '/') {
        output.push(' ', ' ');
        index += 1;
        state = 'line';
      } else if (character === '/' && next === '*') {
        output.push(' ', ' ');
        index += 1;
        state = 'block';
      } else {
        output.push(character);
      }
    } else if (state === 'line') {
      output.push(character === '\n' ? '\n' : ' ');
      if (character === '\n') {
        state = 'code';
      }
    } else if (character === '*' && next === '/') {
      output.push(' ', ' ');
      index += 1;
      state = 'code';
    } else {
      output.push(character === '\n' ? '\n' : ' ');
    }
  }
  return output.join('');
}

function createLineIndex(source) {
  // A direct offset-to-line table makes each finding lookup O(1).  The old
  // implementation recounted every preceding newline for every regexp match,
  // which became quadratic for valid 2 MiB sources containing many matches.
  const lineByOffset = new Uint32Array(source.length + 1);
  let line = 1;
  for (let index = 0; index < source.length; index += 1) {
    lineByOffset[index] = line;
    if (source[index] === '\n') {
      line += 1;
    }
  }
  lineByOffset[source.length] = line;
  let lookups = 0;
  return {
    lineAt(offset) {
      lookups += 1;
      const boundedOffset = Math.max(0, Math.min(source.length, Number.isFinite(offset) ? offset : 0));
      return lineByOffset[boundedOffset];
    },
    stats() {
      return {
        lineIndex: 'offset-table',
        lineCount: line,
        lineIndexBuildSteps: source.length,
        lineLookups: lookups,
        lineLookupSteps: lookups,
      };
    },
  };
}

function allLines(source, expression, lineIndex) {
  const regex = new RegExp(expression.source, expression.flags.includes('g') ? expression.flags : `${expression.flags}g`);
  const lines = new Set();
  for (let match = regex.exec(source); match; match = regex.exec(source)) {
    lines.add(lineIndex.lineAt(match.index));
    if (match[0] === '') {
      regex.lastIndex += 1;
    }
  }
  return [...lines].sort((left, right) => left - right);
}

function addFinding(findings, severity, category, code, line, message) {
  const key = `${severity}\u0000${category}\u0000${code}\u0000${line}\u0000${message}`;
  if (!findings.seen.has(key)) {
    findings.seen.add(key);
    findings.items.push({ severity, category, code, line, message });
  }
}

function addLines(findings, lines, severity, category, code, message) {
  for (const line of lines.slice(0, MAX_FINDINGS_PER_RULE)) {
    addFinding(findings, severity, category, code, line, message);
  }
  if (lines.length > MAX_FINDINGS_PER_RULE) {
    addFinding(
      findings,
      'info',
      'analysis',
      `${code}_truncated`,
      lines[MAX_FINDINGS_PER_RULE],
      'Additional occurrences were omitted from this human-oriented finding list.',
    );
  }
}

function sortFindings(findings) {
  const rank = { error: 0, warning: 1, info: 2 };
  return findings.items.sort(
    (left, right) =>
      left.line - right.line ||
      (rank[left.severity] ?? 9) - (rank[right.severity] ?? 9) ||
      left.category.localeCompare(right.category) ||
      left.code.localeCompare(right.code),
  );
}

function functionDefinitionLines(source, name, lineIndex) {
  return allLines(source, new RegExp(`\\bvoid\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g'), lineIndex);
}

function parseUniformDeclarations(source, lineIndex) {
  const declarations = [];
  const declarationRanges = [];
  const expression = /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?([A-Za-z_]\w*)\s+([^;]+);/g;
  for (let match = expression.exec(source); match; match = expression.exec(source)) {
    const type = match[1];
    const names = match[2].split(',');
    for (const candidate of names) {
      const nameMatch = /\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?/.exec(candidate);
      if (nameMatch) {
        const offset = match.index + match[0].indexOf(candidate) + nameMatch.index;
        declarations.push({ name: nameMatch[1], type, line: lineIndex.lineAt(offset) });
      }
    }
    declarationRanges.push([match.index, match.index + match[0].length]);
  }
  return { declarations, declarationRanges };
}

function literalNumber(value) {
  if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?f?$/i.test(value.trim())) {
    return null;
  }
  const number = Number(value.trim().replace(/[fF]$/, ''));
  return Number.isFinite(number) ? number : null;
}

function offsetInRanges(offset, ranges) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const [start, end] = ranges[middle];
    if (offset < start) {
      high = middle - 1;
    } else if (offset >= end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function referencesForSymbol(source, symbol, declarationRanges, lineIndex) {
  const expression = new RegExp(`\\b${symbol}\\b`, 'g');
  const lines = new Set();
  for (let match = expression.exec(source); match; match = expression.exec(source)) {
    if (!offsetInRanges(match.index, declarationRanges)) {
      lines.add(lineIndex.lineAt(match.index));
    }
  }
  return [...lines].sort((left, right) => left - right);
}

function inspectLoops(source, findings, target, lineIndex) {
  const loops = { for: [], while: [], doWhile: [], dynamicCount: 0, total: 0 };
  const forExpression = /\bfor\s*\(\s*([^;]*);\s*([^;]*);\s*([^)]*)\)/g;
  for (let match = forExpression.exec(source); match; match = forExpression.exec(source)) {
    const line = lineIndex.lineAt(match.index);
    const initializer = match[1];
    const condition = match[2].trim();
    const comparison = /(?:<=|>=|<|>)\s*(.+)$/.exec(condition);
    const bound = comparison ? comparison[1].trim() : '';
    const dynamic = !comparison || literalNumber(bound) === null;
    const floatCounter = /\bfloat\b/.test(initializer);
    loops.for.push({ line, dynamic, floatCounter, condition });
    loops.total += 1;
    if (dynamic) {
      loops.dynamicCount += 1;
      addFinding(
        findings,
        target === 'unknown' ? 'info' : 'warning',
        'compatibility',
        'non_literal_loop_bound',
        line,
        'This loop bound is not a numeric literal. Verify compiler acceptance and frame cost for the actual target route.',
      );
    }
    if (floatCounter) {
      addFinding(
        findings,
        target === 'unknown' ? 'info' : 'warning',
        'compatibility',
        'float_loop_counter',
        line,
        'A floating-point loop counter needs compiler and frame-budget verification.',
      );
    }
  }
  const whileLines = allLines(source, /\bwhile\s*\(/g, lineIndex);
  for (const line of whileLines) {
    loops.while.push({ line });
    loops.total += 1;
    loops.dynamicCount += 1;
    addFinding(
      findings,
      target === 'unknown' ? 'info' : 'warning',
      'compatibility',
      'while_loop',
      line,
      'While loops need route-specific compiler verification and can be expensive in a full-screen pass.',
    );
  }
  const doWhileLines = allLines(source, /\bdo\s*\{/g, lineIndex);
  for (const line of doWhileLines) {
    loops.doWhile.push({ line });
    loops.total += 1;
    loops.dynamicCount += 1;
    addFinding(
      findings,
      target === 'unknown' ? 'info' : 'warning',
      'compatibility',
      'do_while_loop',
      line,
      'Do/while loops need route-specific compiler verification and can be expensive in a full-screen pass.',
    );
  }
  return loops;
}

function inspectNumericRisks(source, findings, lineIndex) {
  const risks = [];
  const rules = [
    ['normalize', /\bnormalize\s*\(/g, 'zero_normalize', 'normalize() can be undefined for a zero-length vector; verify the source invariant before adding a guard.'],
    ['inversesqrt', /\binversesqrt\s*\(/g, 'zero_inversesqrt', 'inversesqrt() needs a positive non-zero input; verify the source invariant.'],
    ['sqrt', /\bsqrt\s*\(/g, 'sqrt_domain', 'sqrt() needs a non-negative input; verify the source range before clamping it.'],
    ['log', /\blog2?\s*\(/g, 'log_domain', 'log()/log2() need a positive input; verify the source range before adding an epsilon.'],
    ['pow', /\bpow\s*\(/g, 'pow_base_domain', 'pow() with a variable base can have a domain risk for non-integral exponents.'],
  ];
  for (const [name, expression, code, message] of rules) {
    const lines = allLines(source, expression, lineIndex);
    if (lines.length) {
      risks.push({ name, lines });
      addLines(findings, lines, 'warning', 'numeric', code, message);
    }
  }
  const divisionLines = allLines(source, /(?<!\/)\/(?![=\/])/g, lineIndex);
  if (divisionLines.length) {
    risks.push({ name: 'division', lines: divisionLines });
    addLines(
      findings,
      divisionLines,
      'warning',
      'numeric',
      'division_denominator',
      'A division was found. Text analysis cannot prove a non-zero denominator; verify the source invariant before changing it.',
    );
  }
  return risks;
}

function calculatePassCost({ textureCalls, derivatives, loops, risks, dynamicIndexing }) {
  let score = 1 + textureCalls.length * 1.5 + derivatives.length * 1.5 + risks.length * 0.5;
  score += loops.for.length * 1.5 + loops.while.length * 4 + loops.doWhile.length * 4;
  score += loops.dynamicCount * 5 + dynamicIndexing.length * 2;
  const level = score <= 4 ? 'low' : score <= 10 ? 'medium' : score <= 20 ? 'high' : 'very-high';
  return {
    level,
    score: Number(score.toFixed(1)),
    rationale: {
      textureCalls: textureCalls.length,
      derivatives: derivatives.length,
      loops: loops.total,
      dynamicLoops: loops.dynamicCount,
      numericRisks: risks.length,
      dynamicIndexing: dynamicIndexing.length,
    },
  };
}

/**
 * Analyze one source string. `target` is only a requested baseline such as
 * `unknown`, `gles100`, or `gles300`; it is not evidence of a real host.
 */
export function analyzeSource(source, options = {}) {
  const settings = typeof options === 'string' ? { path: options } : asObject(options);
  const passName = firstString(settings.passName, settings.name, settings.path) || 'Unnamed pass';
  const target = firstString(settings.target, settings.targetBaseline) || 'unknown';
  if (typeof source !== 'string') {
    throw new TypeError('Shader source must be a string.');
  }
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  if (sourceBytes > MAX_SOURCE_BYTES) {
    return {
      passName,
      status: 'skipped',
      targetBaseline: target,
      sourceBytes,
      entrypoints: [],
      uniforms: [],
      shadertoyUniforms: {},
      channels: [],
      findings: [
        {
          severity: 'error',
          category: 'input',
          code: 'source_too_large',
          line: 1,
          message: `Source is ${sourceBytes} bytes, above the ${MAX_SOURCE_BYTES}-byte safety limit.`,
        },
      ],
      cost: { level: 'unknown', score: null, rationale: {} },
      scan: {
        lineIndex: 'not-built',
        lineCount: null,
        lineIndexBuildSteps: 0,
        lineLookups: 0,
        lineLookupSteps: 0,
      },
      compiled: false,
      disclaimer: ANALYSIS_DISCLAIMER,
    };
  }

  const sanitized = stripComments(source);
  const lineIndex = createLineIndex(sanitized);
  const findings = { items: [], seen: new Set() };
  const entrypoints = [];
  const mainImageLines = functionDefinitionLines(sanitized, 'mainImage', lineIndex);
  const mainLines = functionDefinitionLines(sanitized, 'main', lineIndex);
  if (mainImageLines.length) {
    entrypoints.push({ name: 'mainImage', lines: mainImageLines });
    addLines(
      findings,
      mainImageLines,
      'info',
      'entrypoint',
      'shadertoy_mainImage',
      'Shadertoy-style mainImage() was found; a verified target wrapper and uniform mapping are still required.',
    );
  }
  if (mainLines.length) {
    entrypoints.push({ name: 'main', lines: mainLines });
    addLines(
      findings,
      mainLines,
      'info',
      'entrypoint',
      'direct_main',
      'A direct main() entry point was found; verify the target stage and host interface before reuse.',
    );
  }
  if (!entrypoints.length) {
    addFinding(
      findings,
      passName.toLowerCase() === 'common' ? 'info' : 'warning',
      'entrypoint',
      passName.toLowerCase() === 'common' ? 'common_without_entrypoint' : 'entrypoint_not_found',
      1,
      passName.toLowerCase() === 'common'
        ? 'No executable entry point was found, which is consistent with a Common pass; wiring still needs verification.'
        : 'No mainImage() or main() entry point was found. The source may be incomplete or use another convention.',
    );
  }

  const { declarations: uniforms, declarationRanges } = parseUniformDeclarations(sanitized, lineIndex);
  const shadertoyUniforms = {};
  const channels = [];
  for (const symbol of SHADERTOY_UNIFORMS) {
    const lines = referencesForSymbol(sanitized, symbol, declarationRanges, lineIndex);
    if (lines.length) {
      shadertoyUniforms[symbol] = lines;
      if (/^iChannel[0-3]$/.test(symbol)) {
        channels.push({ name: symbol, index: Number(symbol.slice(-1)), lines });
        addLines(
          findings,
          lines,
          'info',
          'shadertoy_input',
          'ichannel_reference',
          `${symbol} is referenced. Map its texture or feedback buffer only through a verified target pass configuration.`,
        );
      } else {
        addLines(
          findings,
          lines,
          'info',
          'shadertoy_input',
          'shadertoy_uniform_reference',
          `${symbol} is referenced. Do not assume a target uniform name without checking the actual render route.`,
        );
      }
    }
  }

  const versionMatches = [];
  const versionExpression = /^[ \t]*#[ \t]*version[ \t]+(\d+)(?:[ \t]+(es|core|compatibility))?.*$/gim;
  for (let match = versionExpression.exec(sanitized); match; match = versionExpression.exec(sanitized)) {
    versionMatches.push({
      line: lineIndex.lineAt(match.index),
      number: Number(match[1]),
      profile: (match[2] ?? '').toLowerCase() || null,
      directive: match[0].trim(),
    });
  }
  const version = versionMatches[0] ?? null;
  if (version) {
    addFinding(
      findings,
      target === 'unknown' ? 'info' : 'warning',
      'compatibility',
      'version_directive',
      version.line,
      target === 'unknown'
        ? `${version.directive} was found. The actual host dialect remains unverified.`
        : `${version.directive} was found. Verify it against the requested ${target} baseline and host-injected headers.`,
    );
  }

  const textureCalls = [];
  const textureExpression = /\b(texture|texture2D|textureCube|texelFetch|textureLod|textureGrad|textureProj)\s*\(/g;
  for (let match = textureExpression.exec(sanitized); match; match = textureExpression.exec(sanitized)) {
    textureCalls.push({ name: match[1], line: lineIndex.lineAt(match.index) });
  }
  if (textureCalls.length) {
    addLines(
      findings,
      [...new Set(textureCalls.map((call) => call.line))],
      target === 'unknown' ? 'info' : 'warning',
      'compatibility',
      'texture_sampling',
      'Texture sampling was found. Sampler type, binding, UV convention, filtering, and target dialect still need route-specific verification.',
    );
  }
  const derivatives = allLines(sanitized, /\b(?:dFdx|dFdy|fwidth)\s*\(/g, lineIndex);
  if (derivatives.length) {
    addLines(
      findings,
      derivatives,
      target === 'unknown' ? 'info' : 'warning',
      'compatibility',
      'derivatives',
      'Derivative functions require target support; source-only analysis cannot confirm extension, stage, or host availability.',
    );
  }

  const dynamicIndexing = allLines(sanitized, /\b[A-Za-z_]\w*\s*\[\s*(?!\d+\s*\])[^\]\r\n]+\]/g, lineIndex);
  if (dynamicIndexing.length) {
    addLines(
      findings,
      dynamicIndexing,
      target === 'unknown' ? 'info' : 'warning',
      'compatibility',
      'dynamic_array_indexing',
      'Non-literal array indexing was found and needs target compiler verification.',
    );
  }
  const loops = inspectLoops(sanitized, findings, target, lineIndex);
  const risks = inspectNumericRisks(sanitized, findings, lineIndex);
  const discardLines = allLines(sanitized, /\bdiscard\s*;/g, lineIndex);
  if (discardLines.length) {
    addLines(
      findings,
      discardLines,
      'info',
      'compatibility',
      'discard',
      'discard changes alpha/depth behavior and needs a verified material/fallback path.',
    );
  }
  const cost = calculatePassCost({ textureCalls, derivatives, loops, risks, dynamicIndexing });
  return {
    passName,
    status: 'analyzed',
    targetBaseline: target,
    sourceBytes,
    entrypoints,
    uniforms,
    shadertoyUniforms,
    channels,
    version,
    textureCalls,
    derivatives,
    loops,
    risks,
    dynamicIndexing,
    cost,
    costLevel: cost.level,
    scan: lineIndex.stats(),
    findings: sortFindings(findings),
    compiled: false,
    disclaimer: ANALYSIS_DISCLAIMER,
  };
}

function normalizedToken(value) {
  return firstIdentifier(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function passAliases(pass) {
  const aliases = new Set();
  for (const value of [pass.id, pass.name, pass.type]) {
    const token = normalizedToken(value);
    if (token) {
      aliases.add(token);
    }
  }
  const bufferName = /^buffer\s*([a-d])$/i.exec(pass.name);
  if (bufferName) {
    const number = bufferName[1].toLowerCase().charCodeAt(0) - 97;
    aliases.add(`buffer${bufferName[1].toLowerCase()}`);
    aliases.add(`buffer${number.toString().padStart(2, '0')}`);
  }
  return aliases;
}

function inputValues(input) {
  const value = asObject(input);
  return [
    value.sourcePass,
    value.pass,
    value.src,
    value.id,
    value.outputId,
    value.buffer,
    value.source,
    value.name,
  ].filter((candidate) => firstIdentifier(candidate));
}

function inputKind(input) {
  const value = asObject(input);
  return firstString(value.ctype, value.type, value.kind, value.sourceType).toLowerCase();
}

function findCycles(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (adjacency.has(edge.from)) {
      adjacency.get(edge.from).push(edge.to);
    }
  }
  const visited = new Set();
  const inPath = new Set();
  const path = [];
  const seenCycles = new Set();
  const cycles = [];
  function visit(id) {
    visited.add(id);
    inPath.add(id);
    path.push(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!visited.has(next)) {
        visit(next);
      } else if (inPath.has(next)) {
        const cycle = path.slice(path.indexOf(next));
        const canonical = [...cycle].sort().join('|');
        if (!seenCycles.has(canonical)) {
          seenCycles.add(canonical);
          cycles.push(cycle);
        }
      }
    }
    path.pop();
    inPath.delete(id);
  }
  for (const node of nodes) {
    if (!visited.has(node.id)) {
      visit(node.id);
    }
  }
  return cycles;
}

/** Build a pass dependency graph from Shadertoy buffer input/output metadata. */
export function buildPassGraph(project) {
  const normalized = normalizeProject(project);
  const nodes = normalized.renderpasses.map((pass) => ({
    id: `pass:${pass.index}`,
    index: pass.index,
    name: pass.name,
    type: pass.type,
  }));
  const byAlias = new Map();
  const byOutputId = new Map();
  for (const pass of normalized.renderpasses) {
    const nodeId = `pass:${pass.index}`;
    for (const alias of passAliases(pass)) {
      if (!byAlias.has(alias)) {
        byAlias.set(alias, nodeId);
      }
    }
    for (const output of pass.outputs) {
      const item = asObject(output);
      for (const candidate of [item.id, item.ID, item.outputId, item.name, item.src]) {
        const token = normalizedToken(candidate);
        if (token && !byOutputId.has(token)) {
          byOutputId.set(token, nodeId);
        }
      }
    }
  }
  const edges = [];
  const seen = new Set();
  for (const pass of normalized.renderpasses) {
    const to = `pass:${pass.index}`;
    for (let inputIndex = 0; inputIndex < pass.inputs.length; inputIndex += 1) {
      const input = asObject(pass.inputs[inputIndex]);
      const kind = inputKind(input);
      const values = inputValues(input);
      let from = null;
      for (const candidate of values) {
        const token = normalizedToken(candidate);
        from = byOutputId.get(token) ?? byAlias.get(token) ?? null;
        if (from) {
          break;
        }
      }
      const isBufferLike = /(?:buffer|pass|feedback)/.test(kind) || values.some((value) => /buffer|feedback/i.test(firstIdentifier(value)));
      if (!from || !isBufferLike) {
        continue;
      }
      const channel = numberOr(inputIndex, input.channel, input.index, input.slot);
      const key = `${from}\u0000${to}\u0000${channel}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push({ from, to, channel, kind: kind || 'buffer' });
      }
    }
  }
  const cycles = findCycles(nodes, edges);
  const feedbackEdges = edges.filter((edge) => cycles.some((cycle) => cycle.includes(edge.from) && cycle.includes(edge.to)));
  return {
    nodes,
    edges,
    cycles,
    feedback: cycles.length > 0,
    hasFeedback: cycles.length > 0,
    feedbackEdges,
  };
}

function aggregateCost(reports, graph) {
  if (!reports.length) {
    return {
      level: 'unknown',
      score: null,
      rationale: {
        passes: 0,
        analyzedPasses: 0,
        feedback: false,
        passCost: null,
        reason: 'no_renderpasses',
      },
    };
  }
  let score = reports.reduce((sum, report) => sum + (report.cost.score ?? 0), 0);
  if (graph.hasFeedback) {
    score += 6;
  }
  const level = score <= 4 ? 'low' : score <= 10 ? 'medium' : score <= 20 ? 'high' : 'very-high';
  return {
    level,
    score: Number(score.toFixed(1)),
    rationale: {
      passes: reports.length,
      analyzedPasses: reports.filter((report) => report.status === 'analyzed').length,
      feedback: graph.hasFeedback,
      passCost: Number(reports.reduce((sum, report) => sum + (report.cost.score ?? 0), 0).toFixed(1)),
    },
  };
}

/** Analyze every pass and its dependency graph without downloading any media. */
export function analyzeProject(project, options = {}) {
  const settings = asObject(options);
  const normalized = normalizeProject(project);
  const reports = normalized.renderpasses.map((pass) =>
    analyzeSource(pass.code, {
      passName: pass.name,
      target: settings.target ?? settings.targetBaseline ?? 'unknown',
    }),
  );
  const graph = buildPassGraph(normalized);
  const cost = aggregateCost(reports, graph);
  const findings = reports.flatMap((report) =>
    report.findings.map((finding) => ({ ...finding, passName: report.passName })),
  );
  if (!reports.length) {
    findings.push({
      severity: 'warning',
      category: 'input',
      code: 'no_renderpasses',
      line: 1,
      message: 'No render passes were supplied, so this project cannot be considered an analyzed or low-cost porting candidate.',
      passName: null,
    });
  }
  if (graph.hasFeedback) {
    findings.push({
      severity: 'warning',
      category: 'pass_graph',
      code: 'feedback_cycle',
      line: 1,
      message: 'A buffer dependency cycle was found. A target route must explicitly support the required temporal feedback; it cannot be silently flattened.',
      passName: null,
    });
  }
  const status = !reports.length
    ? 'incomplete'
    : reports.every((report) => report.status === 'analyzed')
      ? 'analyzed'
      : 'partial';
  return {
    analyzerVersion: ANALYZER_VERSION,
    status,
    projectId: normalized.id || null,
    sourceBytes: reports.reduce((sum, report) => sum + report.sourceBytes, 0),
    passes: reports,
    graph,
    passGraph: graph,
    feedback: graph.hasFeedback,
    cost,
    costLevel: cost.level,
    findings,
    compiled: false,
    disclaimer: ANALYSIS_DISCLAIMER,
  };
}
