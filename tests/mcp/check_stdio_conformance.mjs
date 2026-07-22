#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entrypoint = path.join(root, 'scripts', 'lp-flow.mjs');
const tempRoot = mkdtempSync(path.join(tmpdir(), 'lp-flow-mcp-conformance-'));
const request = {
  schema: 'lp-flow.burrete-request.v1', request_id: 'mcp:docking', run_id: 'mcp', kind: 'docking_pose_review',
  status: 'ready_for_burrete', recommended_tools: ['open_burrete_docking_view', 'burrete.observe_workspace'],
  artifacts: { receptor: 'receptor.pdb', poses: ['poses.sdf'] },
  expectations: { minimum_poses: 1, pose_navigation_required: false, canvas_nonblank: true },
  receipt_schema: 'lp-flow.burrete-receipt.v1',
};
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
  {
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'lp_flow_prepare_burrete_request',
      arguments: { kind: 'docking_pose_review', out: path.join(tempRoot, 'burrete_request.json'), run_id: 'mcp', receptor: 'receptor.pdb', poses: ['poses.sdf'] },
    },
  },
  {
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
      name: 'lp_flow_record_burrete_receipt',
      arguments: {
        request,
        receipt: {
          request_id: 'mcp:docking', status: 'verified', workspaceSessionId: 'ws-mcp', url: 'burrete://mcp',
          activeDocument: { path: 'poses.sdf', ready: true },
          viewer: { agentAvailable: true, agentReady: true, viewerReady: true },
          visualQa: { canvasNonblank: true, poseCount: 1 },
        },
      },
    },
  },
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
if (lines.length !== 5) throw new Error(`Expected five JSON-RPC responses, received ${lines.length}: ${result.stdout}`);
if ((result.stdout || '').includes('Content-Length')) throw new Error('MCP stdout must be newline-delimited JSON-RPC');

const responses = lines.map(line => JSON.parse(line));
const initialized = responses.find(response => response.id === 1)?.result;
const tools = responses.find(response => response.id === 2)?.result?.tools;
const status = responses.find(response => response.id === 3)?.result;
const requestResult = responses.find(response => response.id === 4)?.result?.structuredContent;
const receiptResult = responses.find(response => response.id === 5)?.result?.structuredContent;
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
if (requestResult?.request?.schema !== 'lp-flow.burrete-request.v1') throw new Error('MCP did not generate a typed Burrete request');
if (receiptResult?.verified !== true || receiptResult?.receipt?.workspaceSessionId !== 'ws-mcp') {
  throw new Error('MCP did not verify the Burrete receipt contract');
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

rmSync(tempRoot, { recursive: true, force: true });

console.log('MCP stdio conformance PASSED');
