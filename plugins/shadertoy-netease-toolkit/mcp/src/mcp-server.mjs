import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ToolInputError,
  createRuntime,
  createToolRegistry,
} from './tools.mjs';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = Object.freeze({
  name: 'shadertoy-netease-mcp',
  version: '0.2.0',
});

// Requests may carry a 2 MiB UTF-8 GLSL source. JSON escaping can materially
// expand that source, so the framing budget is larger while the tool itself
// retains the separate 2 MiB source-byte validation.
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

export const MCP_TRANSPORT_LIMITS = Object.freeze({
  maxRequestBytes: MAX_MESSAGE_BYTES,
  maxResponseBytes: MAX_RESPONSE_BYTES,
});

const RPC_ERROR = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
});

/**
 * A deliberately dependency-free, line-delimited JSON-RPC transport.
 *
 * Standard MCP SDK transports are Content-Length framed in many environments,
 * while this tool is intentionally specified as one UTF-8 JSON object per
 * line.  Nothing except JSON-RPC responses is ever written to stdout.
 */
export class McpStdioServer {
  constructor(options = {}) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.error = options.error || process.stderr;
    this.serverInfo = { ...SERVER_INFO, ...(options.serverInfo || {}) };
    this.runtimeOptions = options.runtimeOptions || {};
    this.runtimeFactory = options.runtimeFactory || createRuntime;
    this.registry = options.registry;
    this.initialized = false;
  }

  async ensureRegistry() {
    if (this.registry) {
      return this.registry;
    }
    const runtime = await this.runtimeFactory(this.runtimeOptions);
    this.registry = createToolRegistry(runtime);
    return this.registry;
  }

  async handleMessage(message) {
    const validation = validateRequest(message);
    if (validation.error) {
      return rpcError(validation.id, RPC_ERROR.invalidRequest, validation.error);
    }

    const { id, isNotification, method, params } = validation;
    try {
      let result;
      switch (method) {
        case 'initialize':
          result = this.initialize(params);
          break;
        case 'notifications/initialized':
          assertRequestParams(params, 'notifications/initialized', []);
          this.initialized = true;
          result = undefined;
          break;
        case 'ping':
          assertRequestParams(params, 'ping', []);
          result = {};
          break;
        case 'tools/list': {
          assertRequestParams(params, 'tools/list', ['cursor']);
          const registry = await this.ensureRegistry();
          result = { tools: registry.list() };
          break;
        }
        case 'tools/call':
          result = await this.callTool(params);
          break;
        default:
          return isNotification ? null : rpcError(id, RPC_ERROR.methodNotFound, 'Method not found.');
      }
      return isNotification ? null : rpcResult(id, result === undefined ? {} : result);
    } catch (error) {
      if (isNotification) {
        this.log('notification handling failed');
        return null;
      }
      if (error instanceof ToolInputError) {
        return rpcError(id, RPC_ERROR.invalidParams, error.message, error.details);
      }
      this.log('request handling failed');
      return rpcError(id, RPC_ERROR.internal, 'Internal error.');
    }
  }

  initialize(params) {
    assertRequestParams(params, 'initialize', ['protocolVersion', 'capabilities', 'clientInfo']);
    return {
      // Advertise only the version this server implements. Echoing an
      // arbitrary client string incorrectly claims support for it.
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: this.serverInfo,
      instructions: 'Use the local Shadertoy library. API refresh and catalog sync require SHADERTOY_API_KEY.',
    };
  }

  async callTool(params) {
    const request = assertPlainObject(params, 'tools/call parameters must be an object.');
    assertKnownKeys(request, ['name', 'arguments', '_meta'], 'tools/call');
    assertRequestMeta(request, 'tools/call');
    if (typeof request.name !== 'string' || !request.name.length || request.name.length > 80) {
      throw new ToolInputError('tools/call name must be a non-empty string.');
    }
    const args = Object.prototype.hasOwnProperty.call(request, 'arguments')
      ? assertPlainObject(request.arguments, 'tools/call arguments must be an object.')
      : {};
    const registry = await this.ensureRegistry();
    if (typeof registry.has === 'function' && !registry.has(request.name)) {
      throw new ToolInputError('Unknown tool name.', { name: request.name });
    }
    return registry.call(request.name, args);
  }

  async start() {
    // Do not use readline here: it buffers an arbitrary no-newline input
    // before `line` fires. We parse Buffers directly and pause stdin while a
    // complete request is being handled, which bounds retained input and
    // preserves request/response ordering under a fast client.
    let processing = Promise.resolve();
    let ending = false;
    let settled = false;

    const finish = (resolve) => {
      if (ending) {
        return;
      }
      ending = true;
      processing = processing
        .then(() => this.finishInput())
        .catch(() => this.log('line handling failed'))
        .finally(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
    };

    await new Promise((resolve) => {
      const onData = (chunk) => {
        // Backpressure at the stream boundary prevents a queue of complete
        // but unprocessed requests from accumulating in user-space.
        if (typeof this.input.pause === 'function') {
          this.input.pause();
        }
        processing = processing
          .then(() => this.consumeChunk(chunk))
          .catch(() => this.log('line handling failed'))
          .finally(() => {
            if (!ending && typeof this.input.resume === 'function') {
              this.input.resume();
            }
          });
      };
      this.input.on('data', onData);
      this.input.once('end', () => finish(resolve));
      this.input.once('close', () => finish(resolve));
      this.input.once('error', () => {
        this.log('stdin failed');
        finish(resolve);
      });
      if (typeof this.input.resume === 'function') {
        this.input.resume();
      }
    });
  }

  async consumeChunk(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== 0x0A) {
        continue;
      }
      await this.consumeLineSegment(buffer.subarray(start, index), true);
      start = index + 1;
    }
    if (start < buffer.length) {
      await this.consumeLineSegment(buffer.subarray(start), false);
    }
  }

  async consumeLineSegment(segment, endsLine) {
    if (this.discardingOversizeLine) {
      if (endsLine) {
        this.discardingOversizeLine = false;
      }
      return;
    }
    const currentBytes = this.lineBytes || 0;
    if (currentBytes + segment.length > MAX_MESSAGE_BYTES) {
      this.lineChunks = [];
      this.lineBytes = 0;
      this.discardingOversizeLine = !endsLine;
      await this.write(rpcError(null, RPC_ERROR.invalidRequest, 'Request exceeds the maximum message size.'));
      return;
    }
    if (segment.length) {
      if (!this.lineChunks) {
        this.lineChunks = [];
      }
      this.lineChunks.push(segment);
      this.lineBytes = currentBytes + segment.length;
    }
    if (!endsLine) {
      return;
    }
    const line = this.takeBufferedLine();
    await this.handleLine(line);
  }

  async finishInput() {
    if (this.discardingOversizeLine) {
      this.discardingOversizeLine = false;
      this.lineChunks = [];
      this.lineBytes = 0;
      return;
    }
    if (this.lineBytes) {
      await this.handleLine(this.takeBufferedLine());
    }
  }

  takeBufferedLine() {
    const chunks = this.lineChunks || [];
    const byteLength = this.lineBytes || 0;
    this.lineChunks = [];
    this.lineBytes = 0;
    const line = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, byteLength);
    return line.length && line[line.length - 1] === 0x0D ? line.subarray(0, -1) : line;
  }

  async handleLine(line) {
    const buffer = Buffer.isBuffer(line) ? line : Buffer.from(String(line), 'utf8');
    if (buffer.length > MAX_MESSAGE_BYTES) {
      await this.write(rpcError(null, RPC_ERROR.invalidRequest, 'Request exceeds the maximum message size.'));
      return;
    }
    let message;
    try {
      message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    } catch {
      await this.write(rpcError(null, RPC_ERROR.parse, 'Parse error.'));
      return;
    }
    const response = await this.handleMessage(message);
    if (response) {
      await this.write(response);
    }
  }

  async write(message) {
    let serialized;
    try {
      serialized = JSON.stringify(message);
    } catch {
      serialized = null;
    }
    if (!serialized || Buffer.byteLength(serialized, 'utf8') + 1 > MAX_RESPONSE_BYTES) {
      serialized = JSON.stringify(responseBudgetError(message));
    }
    // responseBudgetError has a tiny fixed shape. This condition is retained
    // as a final guard rather than ever emitting a partial JSON document.
    if (Buffer.byteLength(serialized, 'utf8') + 1 > MAX_RESPONSE_BYTES) {
      this.log('response exceeded protocol budget');
      return;
    }
    if (this.output.write(`${serialized}\n`) === false) {
      await once(this.output, 'drain');
    }
  }

  log(message) {
    if (this.error?.write) {
      this.error.write(`[shadertoy-netease-mcp] ${message}\n`);
    }
  }
}

function validateRequest(message) {
  const id = validId(message?.id) ? message.id : null;
  if (!isPlainObject(message)) {
    return { id: null, error: 'Invalid Request.' };
  }
  if (message.jsonrpc !== '2.0') {
    return { id, error: 'Invalid Request.' };
  }
  if (typeof message.method !== 'string' || !message.method.length || message.method.length > 120) {
    return { id, error: 'Invalid Request.' };
  }
  if (Object.prototype.hasOwnProperty.call(message, 'id') && !validId(message.id)) {
    return { id: null, error: 'Invalid Request.' };
  }
  return {
    id,
    isNotification: !Object.prototype.hasOwnProperty.call(message, 'id'),
    method: message.method,
    params: message.params,
  };
}

function validId(value) {
  return value === null || (typeof value === 'string' && value.length <= 128) || Number.isSafeInteger(value);
}

function assertOptionalObject(value, message) {
  if (value === undefined) {
    return {};
  }
  return assertPlainObject(value, message);
}

function assertRequestParams(value, method, allowed) {
  const request = assertOptionalObject(value, `${method} parameters must be an object.`);
  assertKnownKeys(request, [...allowed, '_meta'], method);
  assertRequestMeta(request, method);
  return request;
}

function assertRequestMeta(request, method) {
  if (Object.prototype.hasOwnProperty.call(request, '_meta')) {
    assertPlainObject(request._meta, `${method} _meta must be an object.`);
  }
}

function assertPlainObject(value, message) {
  if (!isPlainObject(value)) {
    throw new ToolInputError(message);
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertKnownKeys(value, allowed, method) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new ToolInputError(`${method} parameters contain unsupported properties.`, { properties: unexpected });
  }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: '2.0', id, error };
}

function responseBudgetError(message) {
  const id = validId(message?.id) ? message.id : null;
  if (message?.result && typeof message.result === 'object') {
    const structuredContent = {
      status: 'response_too_large',
      error: {
        code: 'response_too_large',
        message: 'The response exceeds the one MiB protocol budget.',
      },
    };
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: true,
    });
  }
  return rpcError(id, RPC_ERROR.internal, 'Response exceeds the maximum message size.');
}

export async function runMcpServer(options = {}) {
  const server = new McpStdioServer(options);
  await server.start();
}

const invokedDirectly = Boolean(process.argv[1])
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  runMcpServer().catch(() => {
    // stdout is reserved for JSON-RPC.  Avoid stack traces and secrets in
    // stderr too; hosts can use the structured protocol error on requests.
    process.stderr.write('[shadertoy-netease-mcp] startup failed\n');
    process.exitCode = 1;
  });
}
