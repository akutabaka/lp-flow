#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../scripts/lp-flow.mjs';

const controller = new AbortController();
const started = Date.now();
const running = runCommand([
  process.execPath,
  '-e',
  'setTimeout(() => process.exit(0), 10000)',
], { timeout_ms: 15000, signal: controller.signal });
setTimeout(() => controller.abort('test cancellation'), 100);
const result = await running;

if (!result.cancelled) throw new Error(`Expected cancelled=true: ${JSON.stringify(result)}`);
if (result.ok) throw new Error('Cancelled subprocess must not report ok=true');
if (Date.now() - started > 5000) throw new Error('Cancelled subprocess did not terminate promptly');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entrypoint = path.join(root, 'scripts', 'lp-flow.mjs');
const messages = [
  {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lp-flow-cancel-test', version: '1.0' } },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lp_flow_plugin_status', arguments: {} } },
  { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'test cancellation' } },
];
const mcp = spawnSync(process.execPath, [entrypoint, 'mcp'], {
  cwd: root,
  input: `${messages.map(message => JSON.stringify(message)).join('\n')}\n`,
  encoding: 'utf8',
  timeout: 10000,
});
if (mcp.error) throw mcp.error;
if (mcp.status !== 0) throw new Error(`MCP cancellation process exited ${mcp.status}: ${mcp.stderr}`);
const responses = (mcp.stdout || '').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
if (!responses.some(response => response.id === 1)) throw new Error('MCP initialize response is missing');
if (responses.some(response => response.id === 2)) throw new Error('MCP emitted a response after request cancellation');

console.log('MCP subprocess cancellation PASSED');
