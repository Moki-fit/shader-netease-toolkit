import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { ToolRuntimeError, defaultDataDirectory } from '../tools.mjs';
import * as analyzerModule from '../analyzer.mjs';
import { createProviderService } from './provider-service.mjs';
import { createSourceRegistry } from './source-registry.mjs';
import { SourceStore } from './source-store.mjs';

/**
 * The V2 source registry intentionally shares the old data-directory
 * selection rules, but it never opens or migrates library.sqlite3.  Keeping a
 * parallel database makes the existing Shadertoy MCP an independent,
 * backwards-compatible module.
 */
export function defaultSourceDataDirectory(environment = process.env) {
  const explicitSourceDataDir = typeof environment.SHADER_SOURCE_DATA_DIR === 'string'
    ? environment.SHADER_SOURCE_DATA_DIR.trim()
    : '';
  if (explicitSourceDataDir) {
    return explicitSourceDataDir;
  }
  return defaultDataDirectory(environment);
}

export function defaultSourceDatabasePath(environment = process.env, dataDir) {
  return path.join(dataDir || defaultSourceDataDirectory(environment), 'resources-v2.sqlite3');
}

/**
 * Create the runtime used only by the source-registry MCP.  All collaborators
 * are injectable so protocol tests can use fakes without opening SQLite or
 * contacting a provider.
 */
export async function createSourceRuntime(options = {}) {
  const environment = options.environment || process.env;
  const dataDir = options.dataDir || defaultSourceDataDirectory(environment);

  if (!options.store) {
    await mkdir(dataDir, { recursive: true });
  }

  const registry = options.registry || createRegistry(options);
  const store = options.store || createStore(options, defaultSourceDatabasePath(environment, dataDir));
  const analyzer = options.analyzer || analyzerModule;
  const service = options.service || createService(options, { registry, store, environment });

  if (!registry || typeof registry !== 'object') {
    throw new ToolRuntimeError('runtime_unavailable', 'The source registry is unavailable.');
  }
  if (!store || typeof store !== 'object') {
    throw new ToolRuntimeError('runtime_unavailable', 'The source store is unavailable.');
  }
  if (!service || typeof service !== 'object') {
    throw new ToolRuntimeError('runtime_unavailable', 'The source provider service is unavailable.');
  }

  return {
    dataDir,
    registry,
    store,
    service,
    analyzer,
  };
}

function createRegistry(options) {
  const factory = options.createSourceRegistry || createSourceRegistry;
  try {
    return factory(options.registryOptions || {});
  } catch (error) {
    if (error instanceof TypeError && factory === createSourceRegistry) {
      // The built-in factory currently takes no options.  Do not hide errors
      // from a caller-provided factory, which are configuration mistakes.
      return factory();
    }
    throw error;
  }
}

function createStore(options, databasePath) {
  const Store = options.SourceStore || SourceStore;
  try {
    return new Store({ path: databasePath });
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    // Preserve compatibility with small test fakes and an earlier
    // single-path constructor, without weakening the documented constructor.
    return new Store(databasePath);
  }
}

function createService(options, dependencies) {
  const factory = options.createProviderService || createProviderService;
  return factory({
    ...dependencies,
    fetch: options.fetch,
    now: options.now,
  });
}
