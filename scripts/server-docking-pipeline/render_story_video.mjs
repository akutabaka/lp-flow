#!/usr/bin/env node
/**
 * Render a Mol* Stories artifact to a browser-recorded video.
 *
 * This script is intended to run inside a render package, typically on a
 * workstation/server with Node, Playwright/Chromium, and optional ffmpeg.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

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
  node render_story_video.mjs --input story.mvsj --out-dir render_out [options]

Options:
  --input <story>       Story artifact copied into this package. Default: story.mvsj.
  --out-dir <dir>       Output directory. Default: render_out.
  --width <px>          Viewport width. Default: 1920.
  --height <px>         Viewport height. Default: 1080.
  --seconds <n>         Recording duration. Default: 30.
  --warmup-seconds <n>  Wait after viewer load before the final video starts. Default: 20.
  --port <n>            Local HTTP port. Default: 8890.
  --autoplay <bool>     Try to start the story player before recording. Default: true.
  --auto-step <bool>    If no reliable Play runtime is exposed, click Next during recording. Default: true.
  --scene-seconds <n>   Seconds to linger before each automatic Next click. Default: 5.
  --playback-mode <m>   story or cinematic. Cinematic keeps one loaded scene and animates camera. Default: story.
  --require-hardware-webgl <bool>
                         Abort if Chromium falls back to SwiftShader/software WebGL. Default: false.
  --gl <mode>           Chromium GL mode: swiftshader, egl, or default. Default: swiftshader.
  --playwright <pkg>    Playwright package name/path. Default: playwright.
  --ffmpeg <path>       Optional ffmpeg path for trimming the raw WebM.
  --mp4 <bool>          Also attempt MP4 conversion with a full ffmpeg build. Default: false.
  --help                Show this help.
`;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json' || ext === '.mvsj') return 'application/json; charset=utf-8';
  if (ext === '.mvsx') return 'application/octet-stream';
  if (ext === '.bcif') return 'application/octet-stream';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

function viewerHtml(storyName) {
  const format = path.extname(storyName).toLowerCase() === '.mvsx' ? 'mvsx' : 'mvsj';
  const loadExpr = format === 'mvsx'
    ? `fetch(${JSON.stringify(storyName)}).then(r => r.arrayBuffer())`
    : `fetch(${JSON.stringify(storyName)}).then(r => r.json())`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>LP-Flow Story Render</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@mol-view-stories/viewer@5.8.0/dist/mvs-stories.css" />
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #111; }
    mvs-stories-viewer { display: block; width: 100vw; height: 100vh; }
  </style>
</head>
<body>
  <mvs-stories-viewer id="viewer"></mvs-stories-viewer>
  <script type="module">
    import 'https://cdn.jsdelivr.net/npm/@mol-view-stories/viewer@5.8.0/dist/mvs-stories.js';
    window.__RENDER_STATUS = { loaded: false, error: null };
    customElements.whenDefined('mvs-stories-viewer').then(async () => {
      try {
        const viewer = document.getElementById('viewer');
        const data = await ${loadExpr};
        await viewer.loadFromData(data, { format: ${JSON.stringify(format)} });
        window.__RENDER_STATUS.loaded = true;
      } catch (error) {
        window.__RENDER_STATUS.error = String(error && error.stack ? error.stack : error);
      }
    });
  </script>
</body>
</html>`;
}

async function startServer(root, port) {
  const server = http.createServer(async (req, res) => {
    const rawPath = decodeURIComponent(new URL(req.url || '/', `http://127.0.0.1:${port}`).pathname);
    const relative = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
    const resolved = path.resolve(root, relative);
    const relativePath = path.relative(root, resolved);
    const escapedRoot = relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
    if (escapedRoot) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const body = await fs.readFile(resolved);
      res.writeHead(200, { 'Content-Type': contentType(resolved), 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function optionalFfmpeg(ffmpeg, webm, mp4) {
  if (!ffmpeg) return { requested: false };
  return await new Promise(resolve => {
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(ffmpeg, ['-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => done({ requested: true, ok: false, exit_code: null, error: error.message, stdout, stderr, mp4: null }));
    child.on('close', code => done({ requested: true, ok: code === 0, exit_code: code, stdout, stderr, mp4: code === 0 ? mp4 : null }));
  });
}

async function trimWebm(ffmpeg, rawWebm, trimmedWebm, offsetSeconds) {
  if (!ffmpeg || !Number.isFinite(offsetSeconds) || offsetSeconds <= 0) {
    await fs.copyFile(rawWebm, trimmedWebm);
    return { requested: Boolean(ffmpeg), ok: true, mode: 'copy-no-trim', offset_seconds: 0, output: trimmedWebm };
  }
  return await new Promise(resolve => {
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(ffmpeg, [
      '-y',
      '-ss', String(offsetSeconds.toFixed(3)),
      '-i', rawWebm,
      '-c:v', 'libvpx',
      '-deadline', 'realtime',
      '-speed', '8',
      '-b:v', '2M',
      '-an',
      trimmedWebm,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => done({ requested: true, ok: false, exit_code: null, error: error.message, stdout, stderr, output: null, offset_seconds: offsetSeconds }));
    child.on('close', code => done({ requested: true, ok: code === 0, exit_code: code, stdout, stderr, output: code === 0 ? trimmedWebm : null, offset_seconds: offsetSeconds }));
  });
}

async function startPackagedViewerServer({ nodeBin, input, port }) {
  const serveScript = path.join(SCRIPT_DIR, 'serve_mvs_story.mjs');
  try {
    await fs.access(serveScript);
  } catch {
    return null;
  }
  const packagedAssetDir = path.join(SCRIPT_DIR, 'mvs-assets');
  const pluginAssetDir = path.resolve(SCRIPT_DIR, '..', '..', 'assets', 'mvs-stories', '5.8.0');
  const assetDir = await fs.access(packagedAssetDir).then(() => packagedAssetDir).catch(() => pluginAssetDir);
  const args = [
    serveScript,
    '--input', input,
    '--port', String(port),
    '--host', '127.0.0.1',
    '--asset-dir', assetDir,
    '--title', 'LP-Flow Story Render',
  ];
  const child = spawn(nodeBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data.toString('utf8'); });
  child.stderr.on('data', data => { stderr += data.toString('utf8'); });
  child.on('exit', code => {
    if (code !== 0 && !child.killed) stderr += `\nserve_mvs_story exited with code ${code}`;
  });
  const started = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for serve_mvs_story.mjs startup. stderr=${stderr}`));
    }, 30000);
    const poll = () => {
      const start = stdout.indexOf('{');
      const end = stdout.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(stdout.slice(start, end + 1));
          clearTimeout(timeout);
          resolve(parsed);
          return;
        } catch {
          // Keep polling until the JSON object is complete.
        }
      }
      if (child.exitCode !== null) {
        clearTimeout(timeout);
        reject(new Error(`serve_mvs_story.mjs exited before startup JSON. stderr=${stderr}`));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
  return {
    url: started.url,
    artifact: started.artifact,
    format: started.format,
    local_assets: started.local_assets,
    close: async () => {
      child.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      if (child.exitCode === null) child.kill('SIGKILL');
    },
    stdout,
    stderr,
  };
}

async function probeWebgl(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return { ok: false, hardware: false, vendor: null, renderer: null, error: 'no WebGL context' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const text = `${vendor || ''} ${renderer || ''}`.toLowerCase();
    const softwareTokens = ['swiftshader', 'llvmpipe', 'software rasterizer', 'softpipe', 'mesa offscreen'];
    const software = softwareTokens.some(token => text.includes(token));
    return { ok: true, hardware: !software, vendor, renderer, software };
  });
}

async function runCinematicCamera(page, seconds) {
  const box = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('canvas, mvs-stories-viewer, .msp-plugin, body')]
      .map(element => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          area: rect.width * rect.height,
        };
      })
      .filter(rect => rect.width > 100 && rect.height > 100)
      .sort((a, b) => b.area - a.area);
    return candidates[0] || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  });
  const centerX = box.left + box.width * 0.36;
  const centerY = box.top + box.height * 0.52;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  const frames = Math.max(90, Math.floor(seconds * 24));
  const radiusX = Math.max(160, box.width * 0.20);
  const radiusY = Math.max(40, box.height * 0.055);
  for (let i = 0; i < frames; i += 1) {
    const t = i / frames;
    const angle = t * Math.PI * 2;
    const x = centerX + Math.cos(angle) * radiusX;
    const y = centerY + Math.sin(angle) * radiusY;
    await page.mouse.move(x, y, { steps: 1 });
    await page.waitForTimeout(1000 / 24);
  }
  await page.mouse.up();
  return {
    requested: true,
    started: true,
    method: 'continuous-mouse-orbit',
    seconds,
    target_box: box,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }
  const input = path.resolve(String(args.input || args._[0] || 'story.mvsj'));
  const outDir = path.resolve(String(args.outDir || 'render_out'));
  const width = Number.parseInt(args.width || '1920', 10);
  const height = Number.parseInt(args.height || '1080', 10);
  const seconds = Number.parseFloat(args.seconds || '30');
  const warmupSeconds = Number.parseFloat(args.warmupSeconds || '20');
  const port = Number.parseInt(args.port || '8890', 10);
  const autoplay = String(args.autoplay ?? 'true').toLowerCase() !== 'false';
  const autoStep = String(args.autoStep ?? 'true').toLowerCase() !== 'false';
  const sceneSeconds = Number.parseFloat(args.sceneSeconds || '5');
  const playbackMode = String(args.playbackMode || 'story').toLowerCase();
  if (!['story', 'cinematic'].includes(playbackMode)) {
    throw new Error('--playback-mode must be story or cinematic');
  }
  const requireHardwareWebgl = String(args.requireHardwareWebgl ?? 'false').toLowerCase() === 'true';
  const glMode = String(args.gl || 'swiftshader').toLowerCase();
  if (!['swiftshader', 'egl', 'default'].includes(glMode)) {
    throw new Error('--gl must be swiftshader, egl, or default');
  }
  const playwrightPkg = String(args.playwright || 'playwright');
  const ffmpeg = args.ffmpeg ? path.resolve(String(args.ffmpeg)) : '';
  const makeMp4 = String(args.mp4 ?? 'false').toLowerCase() === 'true';
  const nodeBin = process.execPath;

  await fs.mkdir(outDir, { recursive: true });
  const storyName = path.basename(input);
  const packagedStory = path.join(outDir, storyName);
  if (path.resolve(input) !== path.resolve(packagedStory)) {
    await fs.copyFile(input, packagedStory);
  }
  let viewerServer = await startPackagedViewerServer({ nodeBin, input, port });
  if (!viewerServer) {
    await fs.writeFile(path.join(outDir, 'index.html'), viewerHtml(storyName), 'utf8');
  }

  const { chromium } = await import(playwrightPkg);
  const server = viewerServer ? null : await startServer(outDir, port);
  const videoDir = path.join(outDir, 'video');
  await fs.mkdir(videoDir, { recursive: true });
  const browserArgs = ['--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox'];
  if (glMode === 'swiftshader') {
    browserArgs.unshift('--enable-unsafe-swiftshader');
    browserArgs.unshift('--use-angle=swiftshader');
    browserArgs.unshift('--use-gl=angle');
  } else if (glMode === 'egl') {
    browserArgs.unshift('--use-gl=egl');
  }
  const browser = await chromium.launch({
    headless: true,
    args: browserArgs,
  });
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: videoDir, size: { width, height } },
  });
  const page = await context.newPage();
  const url = viewerServer?.url || `http://127.0.0.1:${port}/index.html`;
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    const renderStatus = window.__RENDER_STATUS;
    const mvsStatus = window.__MVS_LOAD_STATUS;
    return renderStatus?.loaded || renderStatus?.error || mvsStatus?.loaded || mvsStatus?.error;
  }, null, { timeout: 120000 });
  const status = await page.evaluate(() => window.__RENDER_STATUS || window.__MVS_LOAD_STATUS);
  if (status?.error) throw new Error(status.error);
  const warnings = [];
  const webglProbe = await probeWebgl(page);
  if (!webglProbe.hardware) {
    warnings.push(`Chromium WebGL renderer is not hardware accelerated: ${webglProbe.renderer || webglProbe.error || 'unknown renderer'}. Smooth large CellPACK videos will likely stutter.`);
    if (requireHardwareWebgl) {
      throw new Error(`Hardware WebGL required but unavailable. Renderer: ${webglProbe.renderer || webglProbe.error || 'unknown renderer'}. Ask the server admin to provide EGL/VirtualGL/NVIDIA render-node access for this user.`);
    }
  }
  if (warmupSeconds > 0) {
    await page.waitForTimeout(warmupSeconds * 1000);
  }
  const presentationStartedAtMs = Date.now();
  let autoplayResult = { requested: autoplay, started: false, method: null };
  if (autoplay && playbackMode === 'story') {
    autoplayResult = await page.evaluate(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const visibleButtons = [...document.querySelectorAll('button, [role="button"]')]
        .filter(button => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      const playButton = visibleButtons.find(button => {
        const label = [
          button.innerText,
          button.textContent,
          button.getAttribute('aria-label'),
          button.getAttribute('title'),
        ].filter(Boolean).join(' ').toLowerCase();
        return /\b(play|start|autoplay|presentation)\b/.test(label);
      });
      if (playButton) {
        playButton.click();
        await sleep(500);
        return { requested: true, started: true, method: 'button' };
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
      await sleep(500);
      return { requested: true, started: false, method: 'space-key-fallback' };
    });
    if (!autoplayResult.started) {
      warnings.push('Could not identify a visible Play button in the story viewer; recording continued after a Space-key fallback.');
    }
  }
  let autoStepResult = { requested: autoStep, started: false, method: null };
  let cinematicResult = { requested: playbackMode === 'cinematic', started: false, method: null };
  if (autoStep && playbackMode === 'story') {
    autoStepResult = await page.evaluate(({ intervalMs }) => {
      const text = document.body?.innerText || '';
      const counts = [...text.matchAll(/(?:\[)?(\d+)\/(\d+)(?:\])?/g)]
        .map(match => Number.parseInt(match[2], 10))
        .filter(Number.isFinite);
      const sceneCount = counts.length ? Math.max(...counts) : null;
      const findNext = () => [...document.querySelectorAll('button, [role="button"]')]
        .filter(button => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .find(button => {
          const label = [
            button.innerText,
            button.textContent,
            button.getAttribute('aria-label'),
            button.getAttribute('title'),
          ].filter(Boolean).join(' ').trim().toLowerCase();
          return label === 'next' || /\b(next|forward)\b/.test(label);
        });
      const next = findNext();
      if (!next) return { requested: true, started: false, method: 'next-button', sceneCount, reason: 'next button not found' };
      let clicks = 0;
      const maxClicks = sceneCount && sceneCount > 1 ? sceneCount - 1 : Number.POSITIVE_INFINITY;
      const timer = window.setInterval(() => {
        const button = findNext();
        if (!button || clicks >= maxClicks) {
          window.clearInterval(timer);
          return;
        }
        button.click();
        clicks += 1;
      }, intervalMs);
      window.__LP_FLOW_RENDER_AUTOSTEP = { timer, sceneCount, maxClicks, intervalMs };
      return { requested: true, started: true, method: 'next-button-interval', sceneCount, maxClicks, intervalMs };
    }, { intervalMs: Math.max(1000, sceneSeconds * 1000) });
    if (!autoStepResult.started) {
      warnings.push(`Automatic scene stepping was requested but did not start: ${autoStepResult.reason || 'unknown reason'}.`);
    }
  }
  if (playbackMode === 'cinematic') {
    cinematicResult = await runCinematicCamera(page, Math.max(1, seconds));
  } else {
    await page.waitForTimeout(Math.max(1, seconds) * 1000);
  }
  const video = await page.video();
  await context.close();
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (viewerServer) await viewerServer.close();
  const rawVideo = video ? await video.path() : null;
  const webm = path.join(outDir, 'story_render.webm');
  const rawWebm = path.join(outDir, 'story_render_raw.webm');
  let trimResult = { requested: false, ok: false };
  if (rawVideo) {
    await fs.copyFile(rawVideo, rawWebm);
    const presentationOffsetSec = (presentationStartedAtMs - startedAtMs) / 1000;
    trimResult = await trimWebm(ffmpeg, rawWebm, webm, presentationOffsetSec);
    if (!trimResult.ok) {
      warnings.push('WebM trim failed; copied the untrimmed raw video to story_render.webm.');
      await fs.copyFile(rawWebm, webm);
    }
  }
  const mp4 = path.join(outDir, 'story_render.mp4');
  const ffmpegResult = makeMp4 ? await optionalFfmpeg(ffmpeg, webm, mp4) : { requested: false, reason: 'mp4 conversion disabled; WebM is the primary output' };
  const manifest = {
    ok: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    input,
    story: packagedStory,
    url,
    viewer_server: viewerServer ? {
      kind: 'serve_mvs_story',
      artifact: viewerServer.artifact,
      format: viewerServer.format,
      local_assets: viewerServer.local_assets,
    } : {
      kind: 'fallback-inline-viewer',
    },
    width,
    height,
    seconds,
    warmup_seconds: warmupSeconds,
    presentation_offset_seconds: rawVideo ? (presentationStartedAtMs - startedAtMs) / 1000 : null,
    autoplay: autoplayResult,
    auto_step: autoStepResult,
    cinematic: cinematicResult,
    playback_mode: playbackMode,
    scene_seconds: sceneSeconds,
    raw_webm: rawVideo ? rawWebm : null,
    webm,
    trim: trimResult,
    mp4: ffmpegResult.ok ? mp4 : null,
    ffmpeg: ffmpegResult,
    warnings,
    webgl: webglProbe,
    renderer: {
      playwright: playwrightPkg,
      chromium_headless: true,
      gl_mode: glMode,
      webgl_args: browserArgs,
    },
  };
  await fs.writeFile(path.join(outDir, 'render_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
