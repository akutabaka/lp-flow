#!/usr/bin/env node
/**
 * Serve a legacy/local native MD trajectory viewer from separate structure +
 * trajectory files. Burrete workflow completion uses a bounded no-water
 * multi-frame PDB display artifact, with native files kept for interpretation.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.gro', 'chemical/x-gromacs-gro'],
  ['.pdb', 'chemical/x-pdb'],
  ['.cif', 'chemical/x-cif'],
  ['.mmcif', 'chemical/x-cif'],
  ['.xtc', 'application/octet-stream'],
  ['.trr', 'application/octet-stream'],
  ['.dcd', 'application/octet-stream'],
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
  node serve_md_trajectory.mjs --structure <reference.gro|pdb|cif> --trajectory <trajectory.xtc|trr|dcd> [--port 8890]

Options:
  --structure <path>      Topology/reference coordinate file. GRO is preferred for GROMACS preview.
  --trajectory <path>     Trajectory file. XTC is preferred for GROMACS preview.
  --port <number>         Preferred port. If busy, the next free port is used. Default: 8890.
  --host <host>           Bind host. Default: 127.0.0.1.
  --title <text>          Browser page title.
  --ngl-url <url>         NGL script URL. Default: https://unpkg.com/ngl@2.0.0-dev.39/dist/ngl.js
`;
}

function existingFile(raw, role) {
  if (!raw) throw new Error(`${role} is required`);
  const resolved = path.resolve(String(raw));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${role} does not exist or is not a file: ${raw}`);
  }
  return resolved;
}

function assertExt(file, allowed, role) {
  const ext = path.extname(file).toLowerCase();
  if (!allowed.includes(ext)) {
    throw new Error(`${role} extension ${ext || '(none)'} is not supported here; expected ${allowed.join(', ')}`);
  }
  return ext.slice(1);
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function preferredPort(host, preferred) {
  for (let port = preferred; port < preferred + 100; port += 1) {
    const ok = await new Promise(resolve => {
      const server = http.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error(`No free port found near ${preferred}`);
}

function viewerHtml({ title, structureExt, trajectoryExt, nglUrl }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title)}</title>
  <script src="${htmlEscape(nglUrl)}"></script>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; font: 13px system-ui, sans-serif; background: #f8fafc; }
    #viewport { position: fixed; inset: 0; }
    #panel { position: fixed; left: 12px; top: 12px; z-index: 10; width: min(430px, calc(100vw - 24px)); background: rgba(17,24,39,.9); color: #f8fafc; padding: 10px 12px; border-radius: 7px; box-shadow: 0 12px 32px rgba(15,23,42,.25); }
    #panel button { height: 28px; margin-right: 6px; border: 1px solid rgba(255,255,255,.18); border-radius: 5px; background: rgba(255,255,255,.1); color: #fff; cursor: pointer; }
    #panel button:disabled { opacity: .45; cursor: default; }
    #frame { width: 170px; vertical-align: middle; }
    #status { margin-top: 5px; color: #cbd5e1; font-size: 12px; }
    #error { margin-top: 6px; color: #fecaca; white-space: pre-wrap; font-size: 12px; }
  </style>
</head>
<body>
  <div id="viewport"></div>
  <div id="panel">
    <div><b>${htmlEscape(title)}</b></div>
    <div style="margin-top:8px">
      <button id="play" disabled>Play</button>
      <button id="pause" disabled>Pause</button>
      <button id="prev" disabled>&lt;</button>
      <button id="next" disabled>&gt;</button>
      <input id="frame" type="range" min="0" max="0" value="0" disabled>
      <span id="frameLabel">0/0</span>
    </div>
    <div id="status">Loading structure + trajectory...</div>
    <div id="error"></div>
  </div>
  <script>
    const statusEl = document.getElementById('status');
    const errorEl = document.getElementById('error');
    const frameEl = document.getElementById('frame');
    const frameLabel = document.getElementById('frameLabel');
    const playBtn = document.getElementById('play');
    const pauseBtn = document.getElementById('pause');
    const prevBtn = document.getElementById('prev');
    const nextBtn = document.getElementById('next');
    window.__LP_FLOW_MD_VIEWER_STATUS = { loaded: false, error: null, frameCount: 0 };

    const stage = new NGL.Stage('viewport', { backgroundColor: 'white' });
    window.stage = stage;
    window.addEventListener('resize', () => stage.handleResize(), false);
    let trajectoryComponent = null;
    let player = null;
    let frameCount = 0;
    let waterRepresentation = null;

    function setEnabled(ok) {
      [playBtn, pauseBtn, prevBtn, nextBtn, frameEl].forEach(item => item.disabled = !ok);
    }

    function setFrame(index) {
      if (!trajectoryComponent || !trajectoryComponent.trajectory || !frameCount) return;
      const wrapped = ((index % frameCount) + frameCount) % frameCount;
      trajectoryComponent.trajectory.setFrame(wrapped);
      frameEl.value = String(wrapped);
      frameLabel.textContent = (wrapped + 1) + '/' + frameCount;
    }

    function fail(error) {
      const message = error && error.message ? error.message : String(error);
      console.error(error);
      window.__LP_FLOW_MD_VIEWER_STATUS = { loaded: false, error: message, frameCount };
      statusEl.textContent = 'Viewer failed.';
      errorEl.textContent = message;
    }

    stage.loadFile('/structure.${structureExt}', { ext: '${structureExt}' }).then(component => {
      window.mdComponent = component;
      component.addRepresentation('line', { sele: 'not water', color: 'element', opacity: 0.34, visible: true });
      component.addRepresentation('cartoon', { sele: 'protein', color: 'chainindex', quality: 'medium' });
      component.addRepresentation('ball+stick', { sele: 'not protein and not water and not ion', color: 'element', radiusScale: 0.45, aspectRatio: 1.6 });
      waterRepresentation = component.addRepresentation('line', { sele: 'water or ion', color: 'lightgrey', opacity: 0.10, visible: false });
      component.autoView('not water', 0);
      statusEl.textContent = 'Structure loaded; parsing local trajectory...';
      return NGL.autoLoad('/trajectory.${trajectoryExt}', { ext: '${trajectoryExt}' }).then(frames => {
        const tc = component.addTrajectory(frames, { defaultStep: 1, defaultTimeout: 90, defaultMode: 'loop' });
        trajectoryComponent = tc;
        window.trajectoryComponent = tc;
        frameCount = tc.trajectory.frameCount || (frames && frames.coordinates && frames.coordinates.length) || 0;
        frameEl.max = String(Math.max(frameCount - 1, 0));
        frameEl.value = '0';
        frameLabel.textContent = frameCount ? '1/' + frameCount : '0/0';
        setEnabled(frameCount > 0);
        player = new NGL.TrajectoryPlayer(tc.trajectory, {
          step: 1,
          timeout: 90,
          start: 0,
          end: Math.max(frameCount - 1, 0),
          interpolateType: 'linear'
        });
        setFrame(0);
        component.autoView('not water', 0);
        stage.viewer.requestRender();
        statusEl.textContent = 'Loaded real trajectory: ' + (frameCount || '?') + ' frames.';
        window.__LP_FLOW_MD_VIEWER_STATUS = { loaded: true, error: null, frameCount };
      });
    }).catch(fail);

    playBtn.onclick = () => player && player.play();
    pauseBtn.onclick = () => player && player.pause();
    prevBtn.onclick = () => setFrame(Number(frameEl.value) - 1);
    nextBtn.onclick = () => setFrame(Number(frameEl.value) + 1);
    frameEl.oninput = () => setFrame(Number(frameEl.value));
  </script>
</body>
</html>`;
}

function sendFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME.get(ext) || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(file).pipe(res);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }
  const structure = existingFile(args.structure || args.topology || args.reference, 'structure');
  const trajectory = existingFile(args.trajectory, 'trajectory');
  const structureExt = assertExt(structure, ['.gro', '.pdb', '.cif', '.mmcif'], 'structure');
  const trajectoryExt = assertExt(trajectory, ['.xtc', '.trr', '.dcd'], 'trajectory');
  const host = String(args.host || '127.0.0.1');
  const port = await preferredPort(host, Number.parseInt(args.port || '8890', 10));
  const title = String(args.title || 'LP-Flow MD trajectory');
  const nglUrl = String(args.nglUrl || 'https://unpkg.com/ngl@2.0.0-dev.39/dist/ngl.js');
  const html = viewerHtml({ title, structureExt, trajectoryExt, nglUrl });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (url.pathname === `/structure.${structureExt}`) {
      sendFile(res, structure);
      return;
    }
    if (url.pathname === `/trajectory.${trajectoryExt}`) {
      sendFile(res, trajectory);
      return;
    }
    if (url.pathname === '/health.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, structure, trajectory, structureExt, trajectoryExt }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  await new Promise(resolve => server.listen(port, host, resolve));
  const url = `http://${host}:${port}/index.html`;
  console.log(JSON.stringify({
    ok: true,
    kind: 'lp-flow-md-trajectory-viewer',
    viewerType: 'md-trajectory',
    displayIntent: 'open-in-codex-preview',
    viewerUrl: url,
    structure,
    trajectory,
    structureExt,
    trajectoryExt,
    served: true,
    port,
    externalBrowserOpenRequested: false,
    note: 'Legacy/local native trajectory viewer: loads structure/topology and trajectory as separate files. Burrete workflow completion uses a bounded no-water multi-frame PDB display artifact.',
  }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
