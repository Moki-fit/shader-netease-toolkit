export const ISF_COMMIT = '1111111111111111111111111111111111111111';
export const WEBGL_COMMIT = '2222222222222222222222222222222222222222';

export const ISF_FRAGMENT = `/*{
  "ISFVSN": "2",
  "LABEL": "Fixture Generator",
  "DESCRIPTION": "An ISF fixture with a persistent pass.",
  "CREDIT": "Fixture Author",
  "CATEGORIES": ["Generator", "Test"],
  "INPUTS": [{"NAME":"gain","TYPE":"float","DEFAULT":0.5}],
  "PASSES": [{"TARGET":"history","PERSISTENT":true,"FLOAT":true}],
  "IMPORTED": {"sprite":{"PATH":"images/sprite.png"}}
}*/
void main() { gl_FragColor = vec4(1.0); }
`;

export const ISF_VERTEX = 'void main() { gl_Position = vec4(0.0); }\n';
export const ISF_SECOND_FRAGMENT = '/*{"ISFVSN":"2","LABEL":"Second fixture"}*/\nvoid main(){gl_FragColor=vec4(0.0);}\n';
export const WEBGL_ENGLISH = '# English lesson\n\nThis English lesson should be the fallback.\n';
export const WEBGL_CHINESE = 'Title: 官方中文标题\nDescription: 官方中文摘要优先于 Markdown 标题。\n# 不应作为标题\n\n这是一段可缓存的中文 WebGL 课程正文。\n';
export const WEBGL_OTHER = '# Other lesson\n\nA first-party English lesson.\n';
export const WEBGL_TRAILING = '# Trailing-slug lesson\n\nA first-party lesson whose official filename ends in a hyphen.\n';

export function githubFilePayload(text, sha = 'abababababababababababababababababababab') {
  return {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(text, 'utf8').toString('base64'),
    sha,
  };
}

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function textResponse(value, status = 200) {
  return new Response(value, {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

export class MemorySourceStore {
  constructor() {
    this.resources = new Map();
    this.states = new Map();
  }

  key(ref) {
    return `${ref.provider}\u0000${ref.id}`;
  }

  upsertResource(record) {
    this.resources.set(this.key(record.ref), structuredClone(record));
    return { ref: record.ref };
  }

  getResource(ref) {
    return structuredClone(this.resources.get(this.key(ref)) || null);
  }

  getSyncState(provider) {
    return structuredClone(this.states.get(provider) || null);
  }

  setSyncState(provider, state) {
    const value = { provider, ...structuredClone(state) };
    this.states.set(provider, value);
    return structuredClone(value);
  }
}
