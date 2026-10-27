import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_URL_LENGTH = 4096;

const passThroughResponseHeaders = new Set([
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
]);

const parseList = (raw, fallback) => {
  const source = typeof raw === 'string' && raw.trim() ? raw : fallback;
  return source
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
};

const parseInteger = (raw, fallback) => {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const decodeTargetUrl = (rawValue) => {
  let value = String(rawValue || '').trim();
  if (!value) return '';

  // Support already-encoded inputs like https%3A%2F%2F...
  for (let i = 0; i < 2; i += 1) {
    if (!/%[0-9a-f]{2}/i.test(value)) break;
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      break;
    }
  }
  return value;
};

/**
 * 创建一个 media proxy 请求处理器。
 * 生产静态服务器与独立 media-proxy 进程共用同一份 allowlist 逻辑。
 */
export const createMediaProxyHandler = (options = {}) => {
  const allowedHostSuffixes = Array.isArray(options.allowedHostSuffixes)
    ? options.allowedHostSuffixes.map((v) => String(v).toLowerCase())
    : parseList(process.env.MEDIA_PROXY_ALLOWED_HOSTS, 'volces.com');
  const allowedProtocols = Array.isArray(options.allowedProtocols)
    ? options.allowedProtocols.map((v) => String(v).toLowerCase())
    : parseList(process.env.MEDIA_PROXY_ALLOWED_PROTOCOLS, 'https');
  const requestTimeoutMs =
    options.requestTimeoutMs ?? parseInteger(process.env.MEDIA_PROXY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxUrlLength =
    options.maxUrlLength ?? parseInteger(process.env.MEDIA_PROXY_MAX_URL_LENGTH, DEFAULT_MAX_URL_LENGTH);
  const corsOrigin = options.corsOrigin || process.env.MEDIA_PROXY_CORS_ORIGIN || '*';

  const setCorsHeaders = (res) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Range');
  };

  const writeJson = (res, statusCode, payload) => {
    setCorsHeaders(res);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };

  const isAllowedTarget = (target) => {
    if (!allowedProtocols.includes(target.protocol.replace(':', '').toLowerCase())) {
      return false;
    }
    const hostname = target.hostname.toLowerCase();
    return allowedHostSuffixes.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
    );
  };

  const buildUpstreamHeaders = (req) => {
    const headers = {};
    if (req.headers.range) headers.range = String(req.headers.range);
    if (req.headers['if-range']) headers['if-range'] = String(req.headers['if-range']);
    if (req.headers['if-none-match']) headers['if-none-match'] = String(req.headers['if-none-match']);
    if (req.headers['if-modified-since']) {
      headers['if-modified-since'] = String(req.headers['if-modified-since']);
    }
    return headers;
  };

  const handleProxyRequest = async (req, res, requestUrl) => {
    const rawTarget = requestUrl.searchParams.get('url');
    if (!rawTarget) {
      writeJson(res, 400, { error: 'Missing url query parameter.' });
      return;
    }

    if (rawTarget.length > maxUrlLength) {
      writeJson(res, 400, { error: 'Target URL is too long.' });
      return;
    }

    // `allow_url` 兼容前端旧参数名
    const decodedTarget = decodeTargetUrl(rawTarget);
    let target;
    try {
      target = new URL(decodedTarget);
    } catch {
      writeJson(res, 400, { error: 'Invalid target URL.' });
      return;
    }

    if (!isAllowedTarget(target)) {
      writeJson(res, 403, { error: 'Target URL is not allowed.' });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const upstream = await fetch(target.toString(), {
        method: 'GET',
        headers: buildUpstreamHeaders(req),
        redirect: 'follow',
        signal: controller.signal,
      });

      setCorsHeaders(res);
      res.statusCode = upstream.status;

      passThroughResponseHeaders.forEach((headerName) => {
        const headerValue = upstream.headers.get(headerName);
        if (headerValue) {
          res.setHeader(headerName, headerValue);
        }
      });

      if (!upstream.body) {
        res.end();
        return;
      }

      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (error) {
      const message =
        error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
          ? `Upstream request timed out (${requestTimeoutMs}ms).`
          : 'Proxy request failed.';
      if (!res.headersSent) {
        writeJson(res, 502, { error: message });
      } else {
        res.end();
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  /** @returns {Promise<void>} */
  return async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = requestUrl.pathname;

      if (req.method === 'OPTIONS') {
        setCorsHeaders(res);
        res.statusCode = 204;
        res.end();
        return;
      }

      if (pathname === '/healthz') {
        writeJson(res, 200, {
          ok: true,
          service: 'media-proxy',
          allowedHostSuffixes,
          allowedProtocols,
        });
        return;
      }

      // 生产态健康探针契约（006 contracts/startup.md:97）：200 { status: 'ok' }
      if (pathname === '/api/media-proxy/health') {
        writeJson(res, 200, { status: 'ok', ok: true, service: 'media-proxy' });
        return;
      }

      if (pathname === '/api/media-proxy') {
        await handleProxyRequest(req, res, requestUrl);
        return;
      }

      writeJson(res, 404, { error: 'Not found.' });
    } catch {
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'Internal server error.' });
      } else {
        res.end();
      }
    }
  };
};

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const PORT = parseInteger(process.env.MEDIA_PROXY_PORT || process.env.PORT, 8787);
  const HOST = process.env.MEDIA_PROXY_HOST || '0.0.0.0';
  const handler = createMediaProxyHandler();
  const server = http.createServer((req, res) => {
    handler(req, res);
  });
  server.listen(PORT, HOST, () => {
    console.log(`[media-proxy] listening on http://${HOST}:${PORT}`);
  });
}
