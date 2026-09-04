import assert from 'node:assert/strict';
import test from 'node:test';

import { extractGodotPageMetadata, getGodotSourcePolicy } from '../../src/sources/normalizers.mjs';

function page(postId, article) {
  return extractGodotPageMetadata(`<body class="postid-${postId}">${article}</body>`);
}

test('Godot HTML tokenizer never treats quoted attributes or inert content as license evidence', () => {
  const cases = [
    page(1, '<article id="post-1" title="<div class=\'shader_license_block\'>MIT License</div>"></article>'),
    page(2, '<textarea><article id="post-2" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></textarea>'),
    page(3, '<title><article id="post-3" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></title>'),
    page(4, '< article id="post-4" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article>'),
    page(5, '<template><article id="post-5" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></template>'),
    page(6, '<div title="<article id=\'post-6\' class=\'shader_license-mit\'><div class=\'shader_license_block\'>MIT License</div></article>'),
    page(7, '<template/><article id="post-7" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article>'),
    page(8, '<script/><article id="post-8" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article>'),
    page(9, '<textarea/><article id="post-9" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article>'),
    page(10, '<article id="post-10"/><article id="post-10" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article>'),
    page(11, '<select><option><article id="post-11" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></option></select>'),
    page(12, '<svg><article id="post-12" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></svg>'),
    page(13, '<math><article id="post-13" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></math>'),
  ];
  for (const item of cases) {
    const policy = getGodotSourcePolicy(item, 'licensed', null);
    assert.equal(policy.pageLicenseEligible, false);
    assert.equal(policy.canFetchSource, false);
  }
});

test('Godot accepts only one document-authoritative body and fails closed on bounded hostile trees', { timeout: 3_000 }, () => {
  const source = '// SPDX-License-Identifier: MIT\nshader_type canvas_item;';
  const htmlDocument = extractGodotPageMetadata('<html><body class="postid-30"><main><article id="post-30" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></main></body></html>');
  assert.equal(getGodotSourcePolicy(htmlDocument, 'licensed', source).cacheAllowed, true);

  const fakeBodies = [
    '<select><option><body class="postid-31"><article id="post-31" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></body></option></select>',
    '<svg><body class="postid-32"><article id="post-32" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></body></svg>',
    '<article><body class="postid-33"><article id="post-33" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></body></article>',
    '<template><body class="postid-34"><article id="post-34" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></body></template>',
    '<body class="postid-35"><article id="post-35" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></body><body class="postid-35"><article id="post-35" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></body>',
    '<html><body class="postid-36"><article id="post-36" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article><body class="postid-36"><article id="post-36" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></body></body></html>',
  ];
  for (const html of fakeBodies) {
    const metadata = extractGodotPageMetadata(html);
    const policy = getGodotSourcePolicy(metadata, 'licensed', source);
    assert.equal(policy.pageLicenseEligible, false);
    assert.equal(policy.canFetchSource, false);
    assert.equal(policy.cacheAllowed, false);
  }

  const deeplyNested = `<body class="postid-37">${'<div>'.repeat(300)}<article id="post-37" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article>${'</div>'.repeat(300)}</body>`;
  const tooManyNodes = `<body class="postid-38">${'<i></i>'.repeat(25_100)}<article id="post-38" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></body>`;
  for (const html of [deeplyNested, tooManyNodes]) {
    const metadata = extractGodotPageMetadata(html);
    const policy = getGodotSourcePolicy(metadata, 'licensed', source);
    assert.equal(policy.pageLicenseEligible, false);
    assert.equal(policy.canFetchSource, false);
    assert.equal(policy.cacheAllowed, false);
  }
});

test('Godot source caching uses only a complete strict SPDX or the exact Bamboo declaration', () => {
  const mitPage = page(10, '<article id="post-10" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article>');
  const validSpdx = getGodotSourcePolicy(mitPage, 'licensed', '// SPDX-License-Identifier: MIT\nshader_type canvas_item;');
  assert.equal(validSpdx.cacheAllowed, true);
  assert.deepEqual([...validSpdx.sourceHeaderLicenses], ['MIT']);

  const bomAtStart = getGodotSourcePolicy(mitPage, 'licensed', '\uFEFF// SPDX-License-Identifier: MIT\nshader_type canvas_item;');
  assert.equal(bomAtStart.cacheAllowed, true);
  assert.deepEqual([...bomAtStart.sourceHeaderLicenses], ['MIT']);

  const bambooPage = page(11, '<article id="post-11" class="shader_license-mit"></article>');
  const bamboo = getGodotSourcePolicy(bambooPage, 'licensed', [
    '// 竹シェーダー by あるる（きのもと 結衣） @arlez80',
    '// Bamboo Shader by Yui Kinomoto',
    '',
    '// MIT License',
    'shader_type spatial;',
  ].join('\n'));
  assert.equal(bamboo.cacheAllowed, true);
  assert.deepEqual([...bamboo.sourceHeaderLicenses], ['MIT']);

  const invalidHeaders = [
    '// SPDX-License-Identifier: MIT\n// Also licensed under CC0.\nshader_type canvas_item;',
    '// SPDX-License-Identifier: MIT\n// All rights are hereby reserved.\nshader_type canvas_item;',
    "// SPDX-License-Identifier: MIT\n// Redistribution is permitted solely with author's written consent.\nshader_type canvas_item;",
    '// SPDX-License-Identifier: MIT\n// Copying allowed for educational purposes only.\nshader_type canvas_item;',
    '/* MIT License */ /* All rights reserved */\nshader_type canvas_item;',
    '// SPDX-License-Identifier: MIT\n/* Licensed under CC0 */\nshader_type canvas_item;',
    '// SPDX-License-Identifier: MIT\n\f// All rights reserved. Do not redistribute.\nshader_type canvas_item;',
    '// SPDX-License-Identifier: MIT\n\v// All rights reserved. Do not redistribute.\nshader_type canvas_item;',
    '// SPDX-License-Identifier: MIT\n\uFEFF// All rights reserved. Do not redistribute.\nshader_type canvas_item;',
  ];
  for (const source of invalidHeaders) {
    const policy = getGodotSourcePolicy(mitPage, 'licensed', source);
    assert.equal(policy.cacheAllowed, false);
    assert.equal(policy.sourceHeaderUnrecognized, true);
    assert.deepEqual([...policy.sourceHeaderLicenses], []);
  }
});

test('Godot invalid scoped blocks and GPL-or-later classes fail closed before source fetch', () => {
  const invalidBlocks = [
    'All rights reserved',
    'MIT License. Personal use only; redistribution prohibited.',
    'Not an MIT License',
  ];
  for (const block of invalidBlocks) {
    const metadata = page(20, `<article id="post-20" class="shader_license-mit"><div class="shader_license_block">${block}</div></article>`);
    const policy = getGodotSourcePolicy(metadata, 'licensed', null);
    assert.equal(metadata.invalidLicenseBlock, true);
    assert.equal(policy.pageLicenseEligible, false);
    assert.equal(policy.canFetchSource, false);
  }
  const gplOrLater = page(21, '<article id="post-21" class="shader_license-gpl3-or-later"><div class="shader_license_block">GPL-3.0-only</div></article>');
  const policy = getGodotSourcePolicy(gplOrLater, 'licensed', null);
  assert.equal(gplOrLater.invalidArticleClass, true);
  assert.equal(policy.pageLicenseEligible, false);
  assert.equal(policy.canFetchSource, false);

  const inertBlock = page(22, '<article id="post-22" class="shader_license-mit"><div class="shader_license_block"><template>MIT License</template></div></article>');
  const inertPolicy = getGodotSourcePolicy(inertBlock, 'licensed', null);
  assert.equal(inertBlock.invalidLicenseBlock, true);
  assert.equal(inertPolicy.pageLicenseEligible, false);
  assert.equal(inertPolicy.canFetchSource, false);

  const nestedArticleBlock = page(23, '<article id="post-23" class="shader_license-mit"><div class="shader_license_block"><article id="post-8">MIT License</article></div></article>');
  const nestedArticlePolicy = getGodotSourcePolicy(nestedArticleBlock, 'licensed', null);
  assert.equal(nestedArticleBlock.invalidLicenseBlock, true);
  assert.equal(nestedArticlePolicy.pageLicenseEligible, false);
  assert.equal(nestedArticlePolicy.canFetchSource, false);

  const nestedTarget = page(24, '<article id="post-999"><article id="post-24" class="shader_license-mit"><div class="shader_license_block">MIT License</div></article></article>');
  const nestedTargetPolicy = getGodotSourcePolicy(nestedTarget, 'licensed', '// SPDX-License-Identifier: MIT\nshader_type canvas_item;');
  assert.equal(nestedTarget.postId, '24');
  assert.equal(nestedTargetPolicy.pageLicenseEligible, false);
  assert.equal(nestedTargetPolicy.canFetchSource, false);
  assert.equal(nestedTargetPolicy.cacheAllowed, false);

  const invalidEvidenceContainers = [
    '<select><option>MIT License</option></select>',
    '<svg>MIT License</svg>',
    '<math>MIT License</math>',
  ];
  for (const [index, content] of invalidEvidenceContainers.entries()) {
    const postId = 25 + index;
    const metadata = page(postId, `<article id="post-${postId}" class="shader_license-mit"><div class="shader_license_block">${content}</div></article>`);
    const policy = getGodotSourcePolicy(metadata, 'licensed', '// SPDX-License-Identifier: MIT\nshader_type canvas_item;');
    assert.equal(metadata.invalidLicenseBlock, true);
    assert.equal(policy.pageLicenseEligible, false);
    assert.equal(policy.canFetchSource, false);
    assert.equal(policy.cacheAllowed, false);
  }
});
