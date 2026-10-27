/**
 * BigBanana 原生画布桥接（Canvas Agent Bridge）
 *
 * 设计目标：
 * 1. 完全本地、零云端依赖：桥接运行在 BigBanana 自己的 3005 生产服务里，页面用同源 SSE 连接；
 * 2. 工具直接驱动「真实页面 + 真实 IndexedDB」：不新开空浏览器，不复制浏览器配置，用户原有项目数据原地可见；
 * 3. MCP 进程只做 JSON-RPC 转发：`server/canvasMcp.mjs` 通过 Bearer Token 调用本桥接的 /api/agent/rpc。
 *
 * 协议版本 1：
 *   GET  /api/agent/status  公开只读状态（是否已连页面 / 挂起命令数）
 *   GET  /api/agent/stream  SSE，页面接入；服务端下发 hello(nonce) 与 command
 *   POST /api/agent/result  页面回传执行结果（以每连接 nonce 鉴权）
 *   POST /api/agent/rpc     MCP 侧发起命令（Bearer Token），等待页面结果
 */
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const CANVAS_AGENT_PROTOCOL = 1;
export const CANVAS_AGENT_STATE_PATH = '.run/canvas-agent.json';

const MAX_BODY_BYTES = 24 * 1024 * 1024;
const HEARTBEAT_MS = 15000;
const DEFAULT_RPC_TIMEOUT_MS = 20000;
const MAX_RPC_TIMEOUT_MS = 120000;

const readJsonBody = (req, limit = MAX_BODY_BYTES) =>
  new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectPromise(Object.assign(new Error('请求体超过大小限制'), { code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        rejectPromise(Object.assign(new Error('请求体不是合法 JSON'), { code: 'INVALID_JSON' }));
      }
    });
    req.on('error', (error) => rejectPromise(error));
  });

const writeSse = (res, event, payload) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
};

const sendJson = (res, statusCode, payload) => {
  if (res.headersSent) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

export function createCanvasAgentBridge({ root, host = '127.0.0.1', port = 3005, logger = console }) {
  const stateFile = resolve(root, ...CANVAS_AGENT_STATE_PATH.split('/'));
  const token = process.env.BB_CANVAS_AGENT_TOKEN || crypto.randomBytes(24).toString('base64url');
  const startedAt = Date.now();

  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        protocol: CANVAS_AGENT_PROTOCOL,
        token,
        endpoint: `http://${host}:${port}/api/agent/rpc`,
        stream: `http://${host}:${port}/api/agent/stream`,
        host,
        port,
        pid: process.pid,
        startedAt,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  /** nonce -> { res, origin, connectedAt } */
  const clients = new Map();
  /** commandId -> { resolve, reject, timer, nonce, method } */
  const pending = new Map();
  let commandSeq = 0;
  let lastClientAt = 0;

  const allowedOrigins = new Set([
    `http://${host}:${port}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);

  const pickClient = () => {
    let chosen = null;
    for (const [nonce, client] of clients) {
      if (!chosen || client.connectedAt > chosen.client.connectedAt) chosen = { nonce, client };
    }
    return chosen;
  };

  const status = () => ({
    ok: true,
    protocol: CANVAS_AGENT_PROTOCOL,
    pageConnected: clients.size > 0,
    pageCount: clients.size,
    pendingCommands: pending.size,
    lastClientAt,
    clients: [...clients.values()].map((client) => ({
      origin: client.origin,
      connectedAt: client.connectedAt,
    })),
    stateFile,
    startedAt,
    uptimeMs: Date.now() - startedAt,
  });

  const dispatch = (method, params = {}, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) =>
    new Promise((resolvePromise, rejectPromise) => {
      if (typeof method !== 'string' || !method) {
        rejectPromise(Object.assign(new Error('缺少 method'), { code: 'INVALID_METHOD' }));
        return;
      }
      const picked = pickClient();
      if (!picked) {
        rejectPromise(
          Object.assign(
            new Error('BigBanana 页面尚未连接桥接通道：请在本机浏览器打开 http://127.0.0.1:3005 并保持页面开启'),
            { code: 'PAGE_OFFLINE' }
          )
        );
        return;
      }
      const id = `cmd-${++commandSeq}-${Date.now().toString(36)}`;
      const budget = Math.min(Math.max(Number(timeoutMs) || DEFAULT_RPC_TIMEOUT_MS, 1000), MAX_RPC_TIMEOUT_MS);
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(Object.assign(new Error(`画布命令超时（${budget}ms）：${method}`), { code: 'COMMAND_TIMEOUT' }));
      }, budget);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, nonce: picked.nonce, method });
      writeSse(picked.client.res, 'command', { id, method, params });
    });

  const complete = (nonce, id, ok, result, error) => {
    const entry = pending.get(id);
    if (!entry) return { ok: false, code: 'UNKNOWN_COMMAND' };
    if (entry.nonce !== nonce) return { ok: false, code: 'NONCE_MISMATCH' };
    clearTimeout(entry.timer);
    pending.delete(id);
    if (ok) {
      entry.resolve(result);
    } else {
      const message = typeof error === 'string' ? error : error && error.message ? error.message : '画布命令执行失败';
      const code = error && error.code ? String(error.code) : 'COMMAND_FAILED';
      entry.reject(Object.assign(new Error(message), { code }));
    }
    return { ok: true };
  };

  const openStream = (req, res) => {
    const origin = req.headers.origin || '';
    // 同源 GET 通常不带 Origin；只有显式跨源时才校验，避免误伤正常页面。
    if (origin && !allowedOrigins.has(origin)) {
      sendJson(res, 403, { ok: false, error: 'ORIGIN_NOT_ALLOWED', origin });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const nonce = crypto.randomBytes(18).toString('base64url');
    const client = { res, origin, connectedAt: Date.now() };
    clients.set(nonce, client);
    lastClientAt = client.connectedAt;
    logger.log(`[canvas-agent] page connected origin=${origin || '(same-origin)'} clients=${clients.size}`);
    writeSse(res, 'hello', { nonce, protocol: CANVAS_AGENT_PROTOCOL, serverTime: Date.now() });

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* 连接已断，交由 close 事件清理 */
      }
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      if (clients.get(nonce) === client) clients.delete(nonce);
      logger.log(`[canvas-agent] page disconnected clients=${clients.size}`);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
  };

  const handleRpc = async (req, res) => {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${token}`) {
      sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '缺少或错误的 Bearer Token' } });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: error.code || 'INVALID_BODY', message: error.message } });
      return;
    }
    try {
      const result = await dispatch(body.method, body.params || {}, body.timeoutMs);
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        error: { code: error.code || 'COMMAND_FAILED', message: error.message || String(error) },
      });
    }
  };

  const handleResult = async (req, res) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: error.code || 'INVALID_BODY', message: error.message } });
      return;
    }
    const outcome = complete(body.nonce, body.id, body.ok === true, body.result, body.error);
    if (!outcome.ok) {
      sendJson(res, 409, { ok: false, error: outcome.code });
      return;
    }
    sendJson(res, 200, { ok: true });
  };

  const handle = async (req, res, pathname) => {
    if (pathname === '/api/agent/status' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, status());
      return true;
    }
    if (pathname === '/api/agent/stream') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return true;
      }
      openStream(req, res);
      return true;
    }
    if (pathname === '/api/agent/result') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return true;
      }
      await handleResult(req, res);
      return true;
    }
    if (pathname === '/api/agent/rpc') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return true;
      }
      await handleRpc(req, res);
      return true;
    }
    return false;
  };

  const close = () => {
    for (const client of clients.values()) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error('画布桥接已关闭'), { code: 'BRIDGE_CLOSED' }));
    }
    pending.clear();
  };

  return { token, stateFile, status, dispatch, handle, close };
}
