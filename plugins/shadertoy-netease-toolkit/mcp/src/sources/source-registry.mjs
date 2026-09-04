import { parseSafeHttpsUrl } from './providers/url-policy.mjs';
import * as bookOfShaders from './providers/book-of-shaders.mjs';
import * as godotShaders from './providers/godot-shaders.mjs';
import * as isf from './providers/isf.mjs';
import * as shaderfrog from './providers/shaderfrog.mjs';
import * as shadertoy from './providers/shadertoy.mjs';
import * as twigl from './providers/twigl.mjs';
import * as webglFundamentals from './providers/webgl-fundamentals.mjs';

const IMPLEMENTATIONS = Object.freeze([
  shadertoy,
  isf,
  twigl,
  bookOfShaders,
  shaderfrog,
  godotShaders,
  webglFundamentals,
]);

export const SOURCE_PROVIDER_IDS = Object.freeze(IMPLEMENTATIONS.map((provider) => provider.descriptor.id));
export const SOURCE_PROVIDERS = Object.freeze(IMPLEMENTATIONS.map((provider) => provider.descriptor));

export function createSourceRegistry() {
  const byId = new Map(IMPLEMENTATIONS.map((provider) => [provider.descriptor.id, provider.descriptor]));

  return Object.freeze({
    list() {
      return SOURCE_PROVIDERS.slice();
    },

    get(id) {
      return typeof id === 'string' ? byId.get(id) || null : null;
    },

    resolveUrl(input) {
      const candidate = parseSafeHttpsUrl(input);
      if (!candidate) {
        return null;
      }
      for (const provider of IMPLEMENTATIONS) {
        const resolved = provider.resolveUrl(candidate);
        if (resolved) {
          return resolved;
        }
      }
      return null;
    },
  });
}
