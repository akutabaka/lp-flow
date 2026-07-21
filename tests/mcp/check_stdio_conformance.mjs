#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entrypoint = path.join(root, 'scripts', 'lp-flow.mjs');
const requests = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lp-flow-conformance', version: '1.0' } },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lp_flow_plugin_status', arguments: {} } },
];
const result = spawnSync(process.execPath, [entrypoint, 'mcp'], {
  cwd: root,
  input: `${requests.map(request => JSON.stringify(request)).join('\n')}\n`,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`MCP process exited ${result.status}\n${result.stderr}`);
const lines = (result.stdout || '').split(/\r?\n/).filter(Boolean);
if (lines.length !== 3) throw new Error(`Expected three JSON-RPC responses, received ${lines.length}: ${result.stdout}`);
if ((result.stdout || '').includes('Content-Length')) throw new Error('MCP stdout must be newline-delimited JSON-RPC');

const responses = lines.map(line => JSON.parse(line));
const initialized = responses.find(response => response.id === 1)?.result;
const tools = responses.find(response => response.id === 2)?.result?.tools;
const status = responses.find(response => response.id === 3)?.result;
if (!initialized?.protocolVersion || !initialized?.serverInfo?.name || !initialized?.capabilities) {
  throw new Error('initialize response is missing MCP protocol, serverInfo, or capabilities');
}
if (initialized.protocolVersion !== '2025-11-25') {
  throw new Error(`initialize did not negotiate the requested protocol version: ${initialized.protocolVersion}`);
}
if (!Array.isArray(tools) || !tools.some(tool => tool.name === 'lp_flow_plugin_status')) {
  throw new Error('tools/list does not expose lp_flow_plugin_status');
}
if (!Array.isArray(status?.content) || !status.content.some(item => item.type === 'text')) {
  throw new Error('lp_flow_plugin_status did not return MCP text content');
}

const preInit = spawnSync(process.execPath, [entrypoint, 'mcp'], {
  cwd: root,
  input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`,
  encoding: 'utf8',
});
const preInitResponse = JSON.parse((preInit.stdout || '').trim());
if (preInitResponse?.error?.code !== -32002) {
  throw new Error(`tools/list before initialization must be rejected: ${preInit.stdout}`);
}

console.log('MCP stdio conformance PASSED');
