import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MCP_PROTOCOL_VERSION,
  MCP_TRANSPORT_LIMITS,
  McpStdioServer,
} from '../mcp-server.mjs';
import { createSourceRuntime } from './source-runtime.mjs';
import { createSourceToolRegistry } from './source-tools.mjs';

export { MCP_PROTOCOL_VERSION, MCP_TRANSPORT_LIMITS };

export const SOURCE_SERVER_INFO = Object.freeze({
  name: 'shader-source-registry-mcp',
  version: '0.2.0',
});

/**
 * The transport inherits the legacy server's bounded, line-delimited
 * JSON-RPC implementation.  Only runtime construction and the seven tool
 * definitions differ, so the original MCP server and its public tool count
 * remain unchanged.
 */
export class SourceMcpStdioServer extends McpStdioServer {
  constructor(options = {}) {
    super({
      ...options,
      serverInfo: { ...SOURCE_SERVER_INFO, ...(options.serverInfo || {}) },
    });
    this.sourceRuntimeFactory = options.sourceRuntimeFactory || options.runtimeFactory || createSourceRuntime;
  }

  async ensureRegistry() {
    if (this.registry) {
      return this.registry;
    }
    const runtime = await this.sourceRuntimeFactory(this.runtimeOptions);
    this.registry = createSourceToolRegistry(runtime);
    return this.registry;
  }

  initialize(params) {
    const result = super.initialize(params);
    return {
      ...result,
      serverInfo: this.serverInfo,
      instructions: 'Use the fixed multi-source shader registry. URL recognition is offline and allowlisted; source/body text is omitted unless a bounded window is explicitly requested. Provider analysis is static only and does not compile, run, or validate a NetEase Minecraft shader.',
    };
  }

  log(message) {
    if (this.error?.write) {
      this.error.write(`[shader-source-registry-mcp] ${message}\n`);
    }
  }
}

export async function runSourceMcpServer(options = {}) {
  const server = new SourceMcpStdioServer(options);
  await server.start();
}

const invokedDirectly = Boolean(process.argv[1])
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  runSourceMcpServer().catch(() => {
    // stdout is reserved for JSON-RPC. Keep even startup failures free of
    // stacks, URLs, keys, database paths, and provider response bodies.
    process.stderr.write('[shader-source-registry-mcp] startup failed\n');
    process.exitCode = 1;
  });
}
