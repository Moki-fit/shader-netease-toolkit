import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSourceRegistry,
  SOURCE_PROVIDER_IDS,
  SOURCE_PROVIDERS,
} from '../../src/sources/source-registry.mjs';

const registry = createSourceRegistry();

const POSITIVE_CASES = [
  {
    provider: 'shadertoy',
    url: 'https://www.shadertoy.com/view/XslGz8',
    id: 'XslGz8',
    canonicalUrl: 'https://www.shadertoy.com/view/XslGz8',
  },
  {
    provider: 'isf',
    url: 'https://github.com/Vidvox/ISF-Files/blob/main/ISF/Test.fs',
    id: 'ISF/Test.fs',
    canonicalUrl: 'https://raw.githubusercontent.com/Vidvox/ISF-Files/main/ISF/Test.fs',
  },
  {
    provider: 'twigl',
    url: 'https://twigl.app/?ol=true&ss=Ab_c-12',
    id: 'Ab_c-12',
    canonicalUrl: 'https://twigl.app/?ol=true&ss=Ab_c-12',
  },
  {
    provider: 'book-of-shaders',
    url: 'https://thebookofshaders.com/03/?lan=ch',
    id: 'chapter-03-ch',
    canonicalUrl: 'https://thebookofshaders.com/03/?lan=ch',
  },
  {
    provider: 'shaderfrog',
    url: 'https://shaderfrog.com/editor/abc_DEF-1',
    id: 'abc_DEF-1',
    canonicalUrl: 'https://shaderfrog.com/editor/abc_DEF-1',
  },
  {
    provider: 'godot-shaders',
    url: 'https://godotshaders.com/shader/water-ripple/',
    id: 'water-ripple',
    canonicalUrl: 'https://godotshaders.com/shader/water-ripple/',
  },
  {
    provider: 'webgl-fundamentals',
    url: 'https://webglfundamentals.org/webgl/lessons/zh_cn/webgl-fundamentals.html',
    id: 'zh_cn/webgl-fundamentals',
    canonicalUrl: 'https://webglfundamentals.org/webgl/lessons/zh_cn/webgl-fundamentals.html',
  },
];

function makeUrl(hostname, pathname, search = '') {
  return `https://${hostname}${pathname}${search}`;
}

test('registry exposes exactly the seven approved source descriptors', () => {
  assert.deepEqual(SOURCE_PROVIDER_IDS, [
    'shadertoy',
    'isf',
    'twigl',
    'book-of-shaders',
    'shaderfrog',
    'godot-shaders',
    'webgl-fundamentals',
  ]);
  assert.equal(registry.list().length, 7);
  assert.equal(registry.get('missing-provider'), null);

  for (const descriptor of SOURCE_PROVIDERS) {
    assert.strictEqual(registry.get(descriptor.id), descriptor);
    for (const field of [
      'id',
      'displayName',
      'kind',
      'homepage',
      'accessMode',
      'capabilities',
      'licensePolicy',
      'networkPolicy',
      'notes',
    ]) {
      assert.ok(Object.hasOwn(descriptor, field), `${descriptor.id} has ${field}`);
    }
    assert.equal(new URL(descriptor.homepage).protocol, 'https:');
    assert.ok(Array.isArray(descriptor.capabilities));
    assert.ok(Array.isArray(descriptor.notes));
  }

  assert.equal(registry.get('isf').networkPolicy.cache, 'first-party-source');
  assert.ok(registry.get('isf').capabilities.includes('official-repository-sync'));
  assert.deepEqual(registry.get('shadertoy').capabilities, [
    'resolve-url',
    'legacy-shadertoy-mcp-delegation',
    'local-analysis',
  ]);
  assert.ok(!registry.get('shadertoy').capabilities.includes('official-api-project-import'));
  assert.equal(registry.get('godot-shaders').accessMode, 'user-link');
  assert.ok(registry.get('godot-shaders').capabilities.includes('single-item-fetch'));
  assert.deepEqual(registry.get('godot-shaders').networkPolicy.allowedEndpoints, [
    '/shader/<slug>/',
    '/wp-json/shader_data/shader/<postId>',
  ]);
  assert.equal(registry.get('webgl-fundamentals').accessMode, 'official-repository');
  assert.equal(registry.get('webgl-fundamentals').networkPolicy.cache, 'first-party-lessons-markdown-only');
});

test('resolves one strict canonical source URL for each provider', () => {
  for (const item of POSITIVE_CASES) {
    const resolved = registry.resolveUrl(item.url);
    assert.ok(resolved, item.provider);
    assert.deepEqual(resolved.ref, { provider: item.provider, id: item.id });
    assert.equal(resolved.canonicalUrl, item.canonicalUrl);
    assert.ok(['shader', 'knowledge'].includes(resolved.kind));
    assert.equal(typeof resolved.accessMode, 'string');
    assert.equal(typeof resolved.licensePolicy.classification, 'string');
    assert.equal(typeof resolved.metadata.sourceType, 'string');
  }
});

test('normalizes an ISF raw URL, twigl inline source, and a Book of Shaders default chapter', () => {
  const isf = registry.resolveUrl('https://raw.githubusercontent.com/Vidvox/ISF-Files/main/ISF/Test.fs');
  assert.deepEqual(isf.ref, { provider: 'isf', id: 'ISF/Test.fs' });
  assert.equal(isf.metadata.inputForm, 'github-raw');
  assert.equal(isf.licensePolicy.spdx, 'MIT');
  const isfAtDifferentRevision = registry.resolveUrl('https://raw.githubusercontent.com/Vidvox/ISF-Files/a1b2c3d4/ISF/Test.fs');
  assert.deepEqual(isfAtDifferentRevision.ref, isf.ref);
  assert.equal(isfAtDifferentRevision.metadata.revision, 'a1b2c3d4');

  const source = 'void main(){gl_FragColor=vec4(1.0);}';
  const twigl = registry.resolveUrl(`https://twigl.app/?mode=8&source=${encodeURIComponent(source)}`);
  assert.equal(twigl.ref.provider, 'twigl');
  assert.match(twigl.ref.id, /^inline-sha256-[a-f0-9]{64}$/);
  assert.equal(twigl.accessMode, 'inline-user-source');
  assert.equal(twigl.metadata.inlineSource, source);
  assert.equal(twigl.metadata.mode, 8);
  assert.equal(twigl.metadata.renderTargets, 'mrt-or-backbuffer-review-required');
  assert.equal(twigl.metadata.audio.enabled, false);
  assert.equal(twigl.licensePolicy.classification, 'unknown');

  const audioSource = 'float sound(float t){return sin(t);}';
  const audioTwigl = registry.resolveUrl(
    `https://twigl.app/?soundsource=${encodeURIComponent(audioSource)}&sound=true&source=${encodeURIComponent(source)}&mode=11`,
  );
  const audioCanonicalQuery = new URLSearchParams([
    ['mode', '11'],
    ['source', source],
    ['sound', 'true'],
    ['soundsource', audioSource],
  ]).toString();
  assert.equal(audioTwigl.canonicalUrl, `https://twigl.app/?${audioCanonicalQuery}`);
  assert.equal(audioTwigl.metadata.mode, 11);
  assert.equal(audioTwigl.metadata.audio.enabled, true);
  assert.equal(audioTwigl.metadata.audio.inlineSoundSource, audioSource);
  assert.equal(audioTwigl.metadata.audio.requiresManualPorting, true);

  const chapter = registry.resolveUrl('https://thebookofshaders.com/03');
  assert.deepEqual(chapter.ref, { provider: 'book-of-shaders', id: 'chapter-03-default' });
  assert.equal(chapter.canonicalUrl, 'https://thebookofshaders.com/03/');
  assert.equal(chapter.licensePolicy.classification, 'no-reuse');
});

test('rejects hostile hosts, explicit ports, credentials, HTTP, and traversal for every provider', () => {
  for (const item of POSITIVE_CASES) {
    const parsed = new URL(item.url);
    const pathname = parsed.pathname;
    const search = parsed.search;
    const host = parsed.hostname;

    const hostileHost = makeUrl(`${host}.example.invalid`, pathname, search);
    const explicitPort = makeUrl(`${host}:443`, pathname, search);
    const credentials = makeUrl(`attacker@${host}`, pathname, search);
    const http = `http://${host}${pathname}${search}`;
    const literalTraversal = makeUrl(host, `/../unsafe${pathname}`, search);
    const encodedTraversal = makeUrl(host, `/%252e%252e${pathname}`, search);

    for (const unsafe of [
      hostileHost,
      explicitPort,
      credentials,
      http,
      literalTraversal,
      encodedTraversal,
    ]) {
      assert.equal(registry.resolveUrl(unsafe), null, `${item.provider} rejected ${unsafe}`);
    }
  }
});

test('rejects non-whitelisted query parameters and twigl ch links', () => {
  assert.equal(registry.resolveUrl('https://www.shadertoy.com/view/XslGz8?mode=full'), null);
  assert.equal(registry.resolveUrl('https://github.com/Vidvox/ISF-Files/blob/main/ISF/Test.fs?raw=1'), null);
  assert.equal(registry.resolveUrl('https://github.com/Vidvox/ISF-Files/blob/main/ISF/Utility/Test.fs'), null);
  assert.equal(registry.resolveUrl('https://twigl.app/?ol=true&ss=Ab_c-12&ch=abc'), null);
  assert.equal(registry.resolveUrl('https://twigl.app/?mode=0&source=void%20main(){}&ch=abc'), null);
  assert.equal(registry.resolveUrl('https://twigl.app/?source=void%20main(){}'), null);
  assert.equal(registry.resolveUrl('https://twigl.app/?mode=12&source=void%20main(){}'), null);
  assert.equal(registry.resolveUrl('https://twigl.app/?mode=0&source=void%20main(){}&sound=true'), null);
  assert.equal(registry.resolveUrl('https://twigl.app/?mode=0&source=void%20main(){}&soundsource=sound'), null);
  assert.equal(registry.resolveUrl('https://thebookofshaders.com/03/?lan=ch&mode=copy'), null);
  assert.equal(registry.resolveUrl('https://shaderfrog.com/editor/abc_DEF-1?copy=1'), null);
  assert.equal(registry.resolveUrl('https://godotshaders.com/shader/water-ripple/?copy=1'), null);
  assert.equal(registry.resolveUrl('https://webglfundamentals.org/webgl/lessons/webgl-fundamentals.html?copy=1'), null);
});

test('marks Godot links for per-work cache and recommendation review after retrieval', () => {
  const resolved = registry.resolveUrl('https://godotshaders.com/shader/water-ripple/');
  assert.equal(resolved.metadata.licenseGate, 'per-work-before-cache-or-recommendation');
  assert.equal(resolved.metadata.requiresLicenseReview, true);
});

test('normalizes official ShaderFrog 2.0 editor shares while rejecting creation and unsafe routes', () => {
  const shared = registry.resolveUrl('https://shaderfrog.com/2/editor/abc_DEF-1');
  assert.deepEqual(shared.ref, { provider: 'shaderfrog', id: 'abc_DEF-1' });
  assert.equal(shared.canonicalUrl, 'https://shaderfrog.com/editor/abc_DEF-1');

  for (const invalid of [
    'https://shaderfrog.com/2/editor/create',
    'https://shaderfrog.com/2/editor/create/template',
    'https://shaderfrog.com/2/editor/abc_DEF-1?copy=1',
    'https://shaderfrog.com/2/editor/%2e%2e',
    'https://shaderfrog.com/2/editor/abc%2Fescape',
  ]) {
    assert.equal(registry.resolveUrl(invalid), null, invalid);
  }
});

test('accepts the official WebGL trailing-hyphen lesson slug without broadening path syntax', () => {
  const slug = 'webgl-qna-a-simple-way-to-show-the-load-on-the-gpu-s-vertex-and-fragment-processing-';
  const resolved = registry.resolveUrl(`https://webglfundamentals.org/webgl/lessons/${slug}.html`);
  assert.deepEqual(resolved.ref, { provider: 'webgl-fundamentals', id: slug });
  assert.equal(resolved.canonicalUrl, `https://webglfundamentals.org/webgl/lessons/${slug}.html`);

  for (const unsafe of [
    'https://webglfundamentals.org/webgl/lessons/.hidden.html',
    'https://webglfundamentals.org/webgl/lessons/lesson..html',
    'https://webglfundamentals.org/webgl/lessons/lesson%2Fescape.html',
    'https://webglfundamentals.org/webgl/lessons/lesson%252e%252e.html',
  ]) {
    assert.equal(registry.resolveUrl(unsafe), null, unsafe);
  }
});

test('is a pure parser and never invokes global fetch', () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error('network access is forbidden in the source registry');
  };
  try {
    for (const item of POSITIVE_CASES) {
      assert.ok(registry.resolveUrl(item.url));
    }
    assert.ok(registry.resolveUrl('https://twigl.app/?mode=0&source=void%20main(){}'));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});
