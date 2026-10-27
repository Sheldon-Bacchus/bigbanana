import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMediaProxyHandler } from './mediaProxyServer.mjs';
import { createNewApiProxyHandler } from './newApiProxyCore.mjs';
import { createCanvasAgentBridge } from './canvasAgentBridge.mjs';

/**
 * 生产静态服务器：dist/ + 同源代理。
 *
 * 为什么不用 `vite preview`：preview 不会运行 vite.config.ts 里的 dev 代理插件，
 * /api/media-proxy 与 /api/new-api 会 404。生产态必须由本服务器同时提供静态文件与代理。
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST_DIR = resolve(ROOT, 'dist');
const INDEX_FILE = resolve(DIST_DIR, 'index.html');

const HOST = process.env.BB_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.BB_PORT || '3005', 10);
const STARTED_AT = Date.now();

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.wasm', 'application/wasm'],
]);

const mediaProxy = createMediaProxyHandler();
const newApiProxy = createNewApiProxyHandler();
// 原生画布桥接：页面同源 SSE 接入，MCP 通过 Bearer Token 调用 /api/agent/rpc
const canvasAgent = createCanvasAgentBridge({ root: ROOT, host: HOST, port: PORT });

const sendJson = (res, statusCode, payload) => {
  if (res.headersSent) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

const statFile = (filePath) => {
  try {
    const info = statSync(filePath);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
};

const streamFile = (req, res, filePath, info) => {
  const ext = extname(filePath).toLowerCase();
  const isHtml = ext === '.html';
  const isHashedAsset = filePath.startsWith(resolve(DIST_DIR, 'assets') + sep);

  res.statusCode = 200;
  res.setHeader('Content-Type', MIME_TYPES.get(ext) || 'application/octet-stream');
  res.setHeader('Content-Length', info.size);
  res.setHeader(
    'Cache-Control',
    isHtml ? 'no-cache' : isHashedAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'
  );

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, 500, { error: 'Failed to read file.' });
    else res.end();
  });
  stream.pipe(res);
};

const serveStatic = (req, res, pathname) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  if (!existsSync(INDEX_FILE)) {
    if (req.headers.accept?.includes('application/json')) {
      sendJson(res, 503, { error: 'dist/ not found. Run `npm run build` first.' });
      return;
    }
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('dist/ not found. Run `npm run build` first, then restart the server.');
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: 'Invalid URL encoding.' });
    return;
  }

  const candidate = resolve(DIST_DIR, `.${decodedPath}`);
  const insideDist = candidate === DIST_DIR || candidate.startsWith(DIST_DIR + sep);

  if (!insideDist) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }

  const info = statFile(candidate);
  if (info) {
    streamFile(req, res, candidate, info);
    return;
  }

  // 无扩展名的路由交给 SPA（React Router）
  if (!extname(decodedPath)) {
    const indexInfo = statFile(INDEX_FILE);
    if (indexInfo) {
      streamFile(req, res, INDEX_FILE, indexInfo);
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found.' });
};

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  if (pathname === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      service: 'bigbanana-prod',
      host: HOST,
      port: PORT,
      uptimeMs: Date.now() - STARTED_AT,
      distReady: existsSync(INDEX_FILE),
    });
    return;
  }

  if (pathname.startsWith('/api/agent/')) {
    Promise.resolve(canvasAgent.handle(req, res, pathname))
      .then((handled) => {
        if (!handled) sendJson(res, 404, { error: 'Unknown agent route.' });
      })
      .catch((error) => {
        sendJson(res, 500, { error: String(error && error.message ? error.message : error) });
      });
    return;
  }

  // 前缀匹配：/api/media-proxy/health 等子路径必须进入媒体代理，不能落到 SPA 静态回退
  if (pathname === '/api/media-proxy' || pathname.startsWith('/api/media-proxy/')) {
    Promise.resolve(mediaProxy(req, res)).catch(() => {
      sendJson(res, 500, { error: 'Media proxy failed.' });
    });
    return;
  }

  if (pathname === '/api/new-api' || pathname.startsWith('/api/new-api/')) {
    Promise.resolve(newApiProxy(req, res)).catch(() => {
      sendJson(res, 500, { error: 'new-api proxy failed.' });
    });
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`[bigbanana-prod] http://${HOST}:${PORT}`);
  console.log(`[bigbanana-prod] root=${ROOT}`);
  console.log(`[bigbanana-prod] dist=${existsSync(INDEX_FILE) ? 'ready' : 'MISSING (run npm run build)'}`);
  console.log(`[bigbanana-prod] canvas-agent state=${canvasAgent.stateFile}`);
});

const shutdown = (signal) => {
  console.log(`[bigbanana-prod] received ${signal}, closing...`);
  canvasAgent.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
