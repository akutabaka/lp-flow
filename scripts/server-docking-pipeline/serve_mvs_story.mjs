#!/usr/bin/env node
/**
 * Serve a Mol View Stories artifact through a stable local viewer wrapper.
 *
 * Supported inputs:
 *   - a directory containing story.mvsx/story.mvsj or index.mvsx/index.mvsj
 *   - a .mvsx or .mvsj file
 *   - a .mvstory file when a sibling .mvsx/.mvsj exists
 *   - a prebuilt .html file
 *
 * The script only serves local files; it does not upload data or depend on a
 * user-specific SSH/server profile.
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_ASSET_DIR = path.join(PLUGIN_ROOT, 'assets', 'mvs-stories', '5.8.0');

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mvsj', 'application/json; charset=utf-8'],
  ['.mvsx', 'application/zip'],
  ['.mvstory', 'application/octet-stream'],
  ['.bcif', 'application/octet-stream'],
  ['.cif', 'chemical/x-cif'],
  ['.pdb', 'chemical/x-pdb'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const raw = item.slice(2);
    const eq = raw.indexOf('=');
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    let value = eq >= 0 ? raw.slice(eq + 1) : true;
    if (value === true && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    }
    args[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/server-docking-pipeline/serve_mvs_story.mjs --input <story-dir|story.mvsx|story.mvsj|story.html> [--port 8765]

Options:
  --input <path>       Story artifact or directory to serve.
  --port <number>     Preferred port. If busy, the next free port is used. Default: 8765.
  --host <host>       Bind host. Default: 127.0.0.1.
  --asset-dir <path>  Directory with mvs-stories.js/css. Default: plugin assets.
  --title <text>      Browser page title.
`;
}

function must(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function existingPath(raw, role) {
  const resolved = path.resolve(String(raw));
  if (!fs.existsSync(resolved)) throw new Error(`${role} does not exist: ${raw}`);
  return resolved;
}

function firstExisting(dir, names) {
  for (const name of names) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function firstByExt(dir, exts) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return entries.find((file) => exts.includes(path.extname(file).toLowerCase())) || null;
}

function resolveInput(input) {
  const resolved = existingPath(input, 'input');
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const artifact = firstExisting(resolved, ['story.mvsx', 'index.mvsx', 'story.mvsj', 'index.mvsj'])
      || firstByExt(resolved, ['.mvsx', '.mvsj'])
      || firstExisting(resolved, ['index.html']);
    if (!artifact) {
      const hasStorySource = fs.existsSync(path.join(resolved, 'story.yaml')) || fs.existsSync(path.join(resolved, 'story.js'));
      if (hasStorySource) {
        throw new Error(`Directory contains Mol View Stories source but no built artifact: ${resolved}
Build it first with the upstream CLI, for example:
  deno run -A <mol-view-stories-checkout>/cli/main.ts build "${resolved}" --format mvsx -o "${path.join(resolved, 'story.mvsx')}"`);
      }
      throw new Error(`No .mvsx/.mvsj/index.html artifact found in ${resolved}`);
    }
    return describeArtifact(artifact);
  }
  if (stat.isFile()) return describeArtifact(resolved);
  throw new Error(`Unsupported input type: ${resolved}`);
}

function describeArtifact(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mvstory') {
    const dir = path.dirname(file);
    const sibling = firstExisting(dir, ['story.mvsx', 'index.mvsx', 'story.mvsj', 'index.mvsj'])
      || firstByExt(dir, ['.mvsx', '.mvsj']);
    if (!sibling) {
      throw new Error(`.mvstory is a session/container companion. Provide a sibling .mvsx/.mvsj artifact or build one first: ${file}`);
    }
    return describeArtifact(sibling);
  }
  if (ext === '.html') {
    return { mode: 'html', file, rootDir: path.dirname(file), format: 'html' };
  }
  if (ext === '.mvsx' || ext === '.mvsj') {
    return {
      mode: 'mvs',
      file,
      rootDir: path.dirname(file),
      format: ext.slice(1),
    };
  }
  throw new Error(`Unsupported artifact extension ${ext}: ${file}`);
}

function hasLocalAssets(assetDir) {
  return fs.existsSync(path.join(assetDir, 'mvs-stories.js'))
    && fs.existsSync(path.join(assetDir, 'mvs-stories.css'));
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function yamlStringField(text, field) {
  const match = String(text).match(new RegExp(`^${field}:\\s*["']?([^"'\\r\\n]+)["']?\\s*$`, 'm'));
  return match ? match[1].trim() : null;
}

function discoverPoseFrames(artifact) {
  const storyYaml = path.join(artifact.rootDir, 'story.yaml');
  const scenesDir = path.join(artifact.rootDir, 'scenes');
  if (!fs.existsSync(storyYaml) || !fs.existsSync(scenesDir)) return [];
  const storyText = fs.readFileSync(storyYaml, 'utf8');
  const folders = [];
  for (const match of storyText.matchAll(/^\s*-\s*folder:\s*["']?([^"'\r\n]+)["']?\s*$/gm)) {
    folders.push(match[1].trim());
  }
  const frames = [];
  for (const folder of folders) {
    const sceneDir = path.join(scenesDir, folder);
    if (!fs.existsSync(sceneDir) || !fs.statSync(sceneDir).isDirectory()) continue;
    const yamlFile = fs.readdirSync(sceneDir).find((name) => name.toLowerCase().endsWith('.yaml'));
    if (!yamlFile) continue;
    const text = fs.readFileSync(path.join(sceneDir, yamlFile), 'utf8');
    const key = yamlStringField(text, 'key') || folder.replace(/^\d+_/, '');
    const header = yamlStringField(text, 'header') || key.replaceAll('_', ' ');
    if (!/_pose_\d+$/i.test(key) && !/\bpose\s+\d+/i.test(header)) continue;
    frames.push({ key, label: header.replace(/:\s*docking pose\s*$/i, '') });
  }
  return frames;
}

function generatedViewerHtml({ title, format, useLocalAssets, poseFrames = [] }) {
  const scriptSrc = useLocalAssets
    ? '/__mvs_assets/mvs-stories.js'
    : 'https://cdn.jsdelivr.net/npm/molstar@5.8.0/build/mvs-stories/mvs-stories.js';
  const cssHref = useLocalAssets
    ? '/__mvs_assets/mvs-stories.css'
    : 'https://cdn.jsdelivr.net/npm/molstar@5.8.0/build/mvs-stories/mvs-stories.css';
  const artifactPath = format === 'mvsx' ? '/index.mvsx' : '/index.mvsj';
  const responseMode = format === 'mvsx' ? 'arrayBuffer' : 'json';
  const dataExpr = format === 'mvsx' ? 'new Uint8Array(payload)' : 'payload';
  const poseFramesJson = JSON.stringify(poseFrames);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title)}</title>
  <link rel="stylesheet" href="${cssHref}">
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; font-family: system-ui, sans-serif; }
    #viewer { position: absolute; inset: 0 34% 0 0; background: #f8f8f8; }
    #controls { position: absolute; inset: 0 0 0 66%; padding: 16px; overflow: auto; background: #f6f5f3; border-left: 1px solid #d7d3cc; }
    #status { position: fixed; left: 12px; bottom: 12px; z-index: 20; max-width: min(520px, calc(100% - 24px)); padding: 8px 10px; border-radius: 6px; background: rgba(0,0,0,.72); color: #fff; font: 12px/1.4 system-ui, sans-serif; }
    #status[data-state="loaded"] { opacity: .2; }
    #status[data-state="error"] { opacity: 1; background: #8a1c1c; }
    #pose-controls { position: fixed; left: 18px; bottom: 18px; z-index: 2147483647; display: none; grid-template-columns: 34px minmax(150px, 1fr) 34px; gap: 8px 10px; align-items: center; width: min(360px, calc(66vw - 36px)); padding: 10px; border-radius: 9px; background: rgba(17,24,39,.9); color: #f9fafb; box-shadow: 0 14px 36px rgba(15,23,42,.28); border: 1px solid rgba(255,255,255,.14); font: 12px/1.2 system-ui, sans-serif; backdrop-filter: blur(8px); }
    #pose-controls button { width: 34px; height: 34px; border: 1px solid rgba(255,255,255,.18); border-radius: 7px; background: rgba(255,255,255,.08); color: #f9fafb; font: 700 18px/1 system-ui, sans-serif; cursor: pointer; }
    #pose-controls button:hover { background: rgba(255,255,255,.16); }
    #pose-controls button:disabled { opacity: .38; cursor: default; }
    #pose-ligand-row { grid-column: 1 / 4; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: center; }
    #pose-ligand-row span { color: #cbd5e1; font-size: 11px; font-weight: 650; text-transform: uppercase; }
    #ligand-select { height: 28px; min-width: 0; border: 1px solid rgba(255,255,255,.18); border-radius: 7px; background: rgba(255,255,255,.08); color: #f9fafb; padding: 0 8px; font: 650 12px/1.2 system-ui, sans-serif; }
    #ligand-select option { color: #111827; background: #fff; }
    #pose-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: center; font-weight: 650; letter-spacing: 0; }
    #pose-counter { display: block; margin-top: 3px; color: #cbd5e1; text-align: center; font-size: 11px; font-weight: 500; }
    #pose-controls[data-ready="true"] { display: grid; }
    @media (orientation: portrait) {
      #viewer { inset: 0 0 40% 0; }
      #controls { inset: 60% 0 0 0; border-left: 0; border-top: 1px solid #d7d3cc; }
      #pose-controls { left: 10px; right: 10px; bottom: calc(40% + 10px); width: auto; }
    }
  </style>
  <script src="${scriptSrc}"></script>
</head>
<body>
  <div id="viewer"><mvs-stories-viewer></mvs-stories-viewer></div>
  <div id="controls"><mvs-stories-snapshot-markdown style="flex-grow:1"></mvs-stories-snapshot-markdown></div>
  <div id="pose-controls" aria-label="Docking pose controls">
    <div id="pose-ligand-row">
      <span>Ligand</span>
      <select id="ligand-select" aria-label="Docking ligand"></select>
    </div>
    <button id="pose-prev" type="button" title="Previous pose" aria-label="Previous pose">&lsaquo;</button>
    <div>
      <div id="pose-title">Pose</div>
      <div id="pose-counter">1 / 1</div>
    </div>
    <button id="pose-next" type="button" title="Next pose" aria-label="Next pose">&rsaquo;</button>
  </div>
  <div id="status" data-state="loading">Loading ${htmlEscape(format.toUpperCase())} story...</div>
  <script>
    window.__MVS_LOAD_STATUS = { loaded: false, error: null, format: ${JSON.stringify(format)} };
    const statusBox = document.getElementById('status');
    function setStatus(state, message) {
      statusBox.dataset.state = state;
      statusBox.textContent = message;
      document.documentElement.dataset.mvsState = state;
      document.documentElement.dataset.mvsFormat = ${JSON.stringify(format)};
      document.documentElement.dataset.mvsMessage = message;
      window.__MVS_LOAD_STATUS[state === 'error' ? 'error' : 'message'] = message;
    }
    const poseControls = document.getElementById('pose-controls');
    const ligandSelect = document.getElementById('ligand-select');
    const poseTitle = document.getElementById('pose-title');
    const poseCounter = document.getElementById('pose-counter');
    const posePrev = document.getElementById('pose-prev');
    const poseNext = document.getElementById('pose-next');
    const serverPoseFrames = ${poseFramesJson};
    let poseLinks = [];
    let poseGroups = [];
    let currentLigandIndex = 0;
    let currentPoseIndex = 0;
    const poseAnchorByKey = new Map();

    function walkDom(root, visit) {
      if (!root) return;
      visit(root);
      const children = root.children ? Array.from(root.children) : [];
      for (const child of children) {
        walkDom(child, visit);
        if (child.shadowRoot) walkDom(child.shadowRoot, visit);
      }
    }

    function collectPoseLinks() {
      const found = [];
      const seen = new Set();
      for (const item of serverPoseFrames) {
        if (!item?.key || seen.has(item.key)) continue;
        seen.add(item.key);
        found.push({ key: item.key, label: item.label || prettyKey(item.key), source: 'story-source' });
      }
      return found;
    }

    function activeViewerModel() {
      try {
        const context = window.mvsStories?.getContext?.();
        const viewers = context?.state?.viewers?.value || [];
        return viewers[0]?.model || null;
      } catch {
        return null;
      }
    }

    function applyStorySnapshot(key) {
      if (!key) return false;
      const model = activeViewerModel();
      const snapshotManager = model?.plugin?.managers?.snapshot;
      if (snapshotManager && typeof snapshotManager.applyKey === 'function') {
        snapshotManager.applyKey(key);
        return true;
      }
      const anchor = poseAnchorByKey.get(key);
      if (anchor?.isConnected && typeof anchor.click === 'function') {
        anchor.click();
        return true;
      }
      return false;
    }

    function cachePoseAnchors() {
      walkDom(document, node => {
        if (!node.matches || !node.matches('a[href^="#"]')) return;
        const key = node.getAttribute('href').slice(1);
        if (!key || !/_pose_\\d+$/i.test(key)) return;
        poseAnchorByKey.set(key, node);
      });
    }

    function hidePoseBrowserMarkdown() {
      walkDom(document, node => {
        if (!node.matches || !node.matches('h1,h2,h3')) return;
        const heading = (node.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        if (heading !== 'pose browser') return;
        let cursor = node;
        while (cursor) {
          cursor.style.display = 'none';
          const next = cursor.nextElementSibling;
          if (!next || (next.matches && next.matches('h1,h2,h3'))) break;
          cursor = next;
        }
      });
    }

    function prettyKey(key) {
      return String(key || '').replaceAll('_', ' ');
    }

    function parsePoseKey(key) {
      const match = String(key || '').match(/^(.+?)_pose_(\\d+)$/i);
      if (!match) return null;
      return {
        ligandKey: match[1],
        ligandLabel: match[1].replace(/_/g, ' '),
        poseNumber: Number(match[2]),
      };
    }

    function groupPoseLinks(items) {
      const byLigand = new Map();
      for (const item of items) {
        const parsed = parsePoseKey(item.key);
        const ligandKey = parsed?.ligandKey || 'poses';
        if (!byLigand.has(ligandKey)) {
          byLigand.set(ligandKey, {
            key: ligandKey,
            label: parsed?.ligandLabel || 'poses',
            items: [],
          });
        }
        const group = byLigand.get(ligandKey);
        group.items.push({
          ...item,
          poseNumber: parsed?.poseNumber || group.items.length + 1,
        });
      }
      return Array.from(byLigand.values()).map(group => ({
        ...group,
        items: group.items.sort((a, b) => a.poseNumber - b.poseNumber),
      }));
    }

    function currentItems() {
      return poseGroups[currentLigandIndex]?.items || [];
    }

    function syncLigandOptions(previousLigandKey = null) {
      ligandSelect.replaceChildren();
      for (const [index, group] of poseGroups.entries()) {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = group.label;
        ligandSelect.appendChild(option);
      }
      if (previousLigandKey) {
        const preserved = poseGroups.findIndex(group => group.key === previousLigandKey);
        if (preserved >= 0) currentLigandIndex = preserved;
      }
      currentLigandIndex = Math.max(0, Math.min(currentLigandIndex, poseGroups.length - 1));
      ligandSelect.value = String(currentLigandIndex);
    }

    function prettyPoseLabel(item) {
      const key = item?.key || '';
      const match = key.match(/^(.+?)_pose_(\\d+)$/i);
      if (match) {
        const ligand = match[1].replace(/_/g, ' ');
        return ligand + ' · pose ' + match[2];
      }
      return item?.label || prettyKey(key) || 'Pose';
    }

    function prettyPoseLabel(item) {
      const parsed = parsePoseKey(item?.key);
      if (parsed) return 'pose ' + parsed.poseNumber;
      return item?.label || prettyKey(item?.key) || 'Pose';
    }

    function refreshPoseControls() {
      const nextLinks = collectPoseLinks();
      if (!nextLinks.length) {
        poseControls.dataset.ready = 'false';
        return;
      }
      const signature = nextLinks.map(item => item.key).join('|');
      const oldSignature = poseLinks.map(item => item.key).join('|');
      const previousLigandKey = poseGroups[currentLigandIndex]?.key;
      poseLinks = nextLinks;
      if (signature !== oldSignature) {
        poseGroups = groupPoseLinks(poseLinks);
        syncLigandOptions(previousLigandKey);
      }
      const hash = window.location.hash ? window.location.hash.slice(1) : '';
      if (hash) {
        for (const [groupIndex, group] of poseGroups.entries()) {
          const itemIndex = group.items.findIndex(item => item.key === hash);
          if (itemIndex >= 0) {
            currentLigandIndex = groupIndex;
            currentPoseIndex = itemIndex;
            ligandSelect.value = String(currentLigandIndex);
            break;
          }
        }
      }
      const items = currentItems();
      currentPoseIndex = Math.max(0, Math.min(currentPoseIndex, items.length - 1));
      poseTitle.textContent = items[currentPoseIndex] ? prettyPoseLabel(items[currentPoseIndex]) : 'Pose';
      poseCounter.textContent = items.length ? (currentPoseIndex + 1) + ' / ' + items.length : '0 / 0';
      posePrev.disabled = items.length <= 1;
      poseNext.disabled = items.length <= 1;
      poseControls.dataset.ready = 'true';
    }

    function goToCurrentPose() {
      const items = currentItems();
      if (!items.length) return;
      currentPoseIndex = Math.max(0, Math.min(currentPoseIndex, items.length - 1));
      const target = items[currentPoseIndex];
      poseTitle.textContent = prettyPoseLabel(target);
      poseCounter.textContent = (currentPoseIndex + 1) + ' / ' + items.length;
      const applied = applyStorySnapshot(target?.key);
      if (!applied && target?.key && window.location.hash !== '#' + target.key) {
        window.location.hash = target.key;
      }
    }

    function stepPose(delta) {
      const items = currentItems();
      if (!items.length) return;
      currentPoseIndex = (currentPoseIndex + delta + items.length) % items.length;
      goToCurrentPose();
    }

    posePrev.addEventListener('click', () => stepPose(-1));
    poseNext.addEventListener('click', () => stepPose(1));
    ligandSelect.addEventListener('change', () => {
      currentLigandIndex = Number(ligandSelect.value);
      currentPoseIndex = 0;
      goToCurrentPose();
    });
    window.addEventListener('keydown', event => {
      const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : '';
      if (tag === 'textarea' || tag === 'select') return;
      if (tag === 'input') return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        stepPose(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        stepPose(1);
      }
    });
    refreshPoseControls();

    async function loadStory() {
      if (!window.mvsStories || typeof window.mvsStories.loadFromData !== 'function') {
        throw new Error('mvsStories loader did not initialize');
      }
      const response = await fetch('${artifactPath}', { cache: 'no-store' });
      if (!response.ok) throw new Error('Failed to fetch ${artifactPath}: HTTP ' + response.status);
      const payload = await response.${responseMode}();
      window.mvsStories.loadFromData(${dataExpr}, { format: ${JSON.stringify(format)} });
      window.__MVS_LOAD_STATUS.loaded = true;
      setStatus('loaded', 'Loaded ${htmlEscape(format.toUpperCase())}: ${htmlEscape(path.basename(artifactPath))}');
      refreshPoseControls();
      window.setTimeout(() => { cachePoseAnchors(); hidePoseBrowserMarkdown(); }, 500);
      window.setTimeout(() => { cachePoseAnchors(); hidePoseBrowserMarkdown(); }, 1400);
      window.setTimeout(() => { cachePoseAnchors(); hidePoseBrowserMarkdown(); }, 2800);
    }
    loadStory().catch((error) => {
      console.error(error);
      window.__MVS_LOAD_STATUS.error = error && error.message ? error.message : String(error);
      setStatus('error', 'Error: ' + window.__MVS_LOAD_STATUS.error);
    });
  </script>
</body>
</html>`;
}

function contentType(file) {
  return MIME.get(path.extname(file).toLowerCase()) || 'application/octet-stream';
}

function safeResolve(rootDir, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const relative = decoded.replace(/^\/+/, '').replaceAll('/', path.sep);
  const resolved = path.resolve(rootDir, relative || '.');
  const root = path.resolve(rootDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function send(res, status, headers, body) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    ...headers,
  });
  res.end(body);
}

async function preferredPort(host, startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, host);
    });
    if (free) return port;
  }
  throw new Error(`No free port found starting at ${startPort}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }

  const input = args.input || args._[0];
  must(input, usage());

  const host = String(args.host || '127.0.0.1');
  const port = await preferredPort(host, Number(args.port || 8765));
  const artifact = resolveInput(input);
  const assetDir = path.resolve(String(args.assetDir || DEFAULT_ASSET_DIR));
  const localAssets = hasLocalAssets(assetDir);
  const title = String(args.title || `Mol View Stories: ${path.basename(artifact.rootDir)}`);

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${host}:${port}`);

      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (artifact.mode === 'html') {
          const file = artifact.file;
          send(res, 200, { 'Content-Type': contentType(file) }, fs.readFileSync(file));
          return;
        }
        send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, generatedViewerHtml({
          title,
          format: artifact.format,
          useLocalAssets: localAssets,
          poseFrames: discoverPoseFrames(artifact),
        }));
        return;
      }

      if (url.pathname === '/index.mvsx' || url.pathname === '/index.mvsj') {
        send(res, 200, { 'Content-Type': contentType(artifact.file) }, fs.readFileSync(artifact.file));
        return;
      }

      if (url.pathname.startsWith('/__mvs_assets/')) {
        const filename = path.basename(url.pathname);
        const file = path.join(assetDir, filename);
        if (!localAssets || !fs.existsSync(file)) {
          send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'MVS asset not found');
          return;
        }
        send(res, 200, { 'Content-Type': contentType(file) }, fs.readFileSync(file));
        return;
      }

      const file = safeResolve(artifact.rootDir, url.pathname);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
        return;
      }
      send(res, 200, { 'Content-Type': contentType(file) }, fs.readFileSync(file));
    } catch (error) {
      send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, error.stack || String(error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const url = `http://${host}:${port}/index.html`;
  console.log(JSON.stringify({
    ok: true,
    url,
    host,
    port,
    input: path.resolve(String(input)),
    artifact: artifact.file,
    format: artifact.format,
    local_assets: localAssets ? assetDir : null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
