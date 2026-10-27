#!/usr/bin/env node
/**
 * BigBanana Canvas MCP（原生、本地、零云端依赖）
 *
 * 结构：
 *   MCP 客户端（DSH） --stdio JSON-RPC--> 本进程 --HTTP/Bearer--> 3005 内置画布桥接 --> 真实页面 --> IndexedDB
 *
 * 与 canvas-agent 的关系：借鉴其「本地 Agent + 浏览器接入 + 原生工具面」形态，
 * 但数据模型完全对齐 BigBanana v4（CanvasGraphEntity / Episode / AssetLibraryItem），不复制其代码。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const STATE_FILE = resolve(ROOT, '.run', 'canvas-agent.json');
const SERVER_NAME = 'bigbanana-canvas';
const SERVER_VERSION = '0.1.0';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

const log = (...args) => {
  // stdout 专供 JSON-RPC，诊断日志一律走 stderr
  process.stderr.write(`[bigbanana-canvas] ${args.join(' ')}\n`);
};

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch (error) {
    throw new Error(
      `找不到画布桥接状态文件：${STATE_FILE}。请先在 BigBanana 目录运行 npm start（固定 3005）并打开页面。`
    );
  }
};

const agentStatus = async () => {
  const state = readState();
  const endpoint = new URL(state.endpoint);
  endpoint.pathname = '/api/agent/status';
  endpoint.search = '';
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
  const payload = await response.json();
  return { ...payload, stateFile: STATE_FILE };
};

const getHttpBase = () => {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    let host = state.host || (state.endpoint ? new URL(state.endpoint).hostname : '127.0.0.1');
    if (host === '0.0.0.0' || host === '::') host = '127.0.0.1';
    const port = state.port || (state.endpoint ? new URL(state.endpoint).port : 3005);
    return `http://${host}:${port || 3005}`;
  } catch {
    return 'http://127.0.0.1:3005';
  }
};

const apiStatus = async () => {
  const base = getHttpBase();
  const [healthzRes, newApiRes] = await Promise.all([
    (async () => {
      try {
        const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(8000) });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
        return { status: res.status, ok: res.ok, data };
      } catch (err) {
        return { status: 0, ok: false, error: err.message };
      }
    })(),
    (async () => {
      try {
        // 该代理的 status 需要显式 endpoint；缺省会报 Failed to parse URL from /api/status
        const relayEndpoint = process.env.BB_NEW_API_ENDPOINT || 'https://api.antsk.cn';
        const res = await fetch(`${base}/api/new-api/status?endpoint=${encodeURIComponent(relayEndpoint)}`, { signal: AbortSignal.timeout(8000) });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
        return { status: res.status, ok: res.ok, data };
      } catch (err) {
        return { status: 0, ok: false, error: err.message };
      }
    })(),
  ]);

  const healthzData = typeof healthzRes.data === 'object' && healthzRes.data !== null ? healthzRes.data : {};
  const newApiData = typeof newApiRes.data === 'object' && newApiRes.data !== null ? newApiRes.data : {};

  return {
    status: healthzRes.status || 200,
    ok: healthzRes.ok,
    service: healthzData.service || 'bigbanana-prod',
    uptime: healthzData.uptimeMs,
    uptimeMs: healthzData.uptimeMs,
    healthz: {
      status: healthzRes.status,
      ...(typeof healthzRes.data === 'object' && healthzRes.data !== null ? healthzRes.data : { body: healthzRes.data }),
    },
    newApi: {
      status: newApiRes.status,
      ...(typeof newApiRes.data === 'object' && newApiRes.data !== null ? newApiRes.data : { body: newApiRes.data }),
    },
  };
};

const apiRequest = async (args = {}) => {
  const { path, body, timeoutMs: rawTimeout } = args;
  const method = String(args.method || 'GET').toUpperCase();

  if (!['GET', 'POST'].includes(method)) {
    throw new Error(`不支持的 HTTP 方法：${args.method}，仅允许 GET 或 POST`);
  }

  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('缺少 path 参数');
  }

  const trimmedPath = path.trim();
  if (!trimmedPath.startsWith('/') || trimmedPath.startsWith('//')) {
    throw new Error(`路径格式不合法：必须以 / 开头，不支持绝对 URL 或协议相对路径（${trimmedPath}）`);
  }

  const parsed = new URL(trimmedPath, 'http://localhost');
  const pathname = parsed.pathname;

  const isAllowed =
    pathname === '/healthz' ||
    pathname.startsWith('/healthz/') ||
    pathname === '/api/new-api' ||
    pathname.startsWith('/api/new-api/');

  if (!isAllowed) {
    throw new Error(`拒绝访问路径：${pathname}。仅允许访问 /healthz 与 /api/new-api/ 前缀`);
  }

  const base = getHttpBase();
  const targetUrl = new URL(trimmedPath, base).toString();
  const timeoutMs = Number(rawTimeout) > 0 ? Number(rawTimeout) : 10000;

  const headers = {};
  let requestBody;
  if (method === 'POST' && body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestBody = typeof body === 'string' ? body : JSON.stringify(body);
  }

  try {
    const response = await fetch(targetUrl, {
      method,
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error(`请求超时（${timeoutMs}ms）：${method} ${trimmedPath}`);
    }
    throw error;
  }
};

const rpc = async (method, params = {}, timeoutMs = 20000) => {
  const state = readState();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number(timeoutMs) || 20000, 1000), 120000) + 5000);
  try {
    const response = await fetch(state.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({ method, params, timeoutMs }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!payload || payload.ok !== true) {
      const detail = payload && payload.error ? `${payload.error.code}: ${payload.error.message}` : `HTTP ${response.status}`;
      throw new Error(detail);
    }
    return payload.result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`调用画布桥接超时：${method}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const resolveMedia = async (args) => {
  if (args.dataUrl) return String(args.dataUrl);
  if (!args.url) throw new Error('必须提供 url 或 dataUrl');
  const response = await fetch(String(args.url), {
    redirect: 'follow',
    headers: { 'User-Agent': 'BigBanana-Canvas-Agent/0.1 (+local)' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`下载素材失败：HTTP ${response.status} ${response.statusText}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_MEDIA_BYTES) throw new Error(`素材超过单次上限（${MAX_MEDIA_BYTES} 字节）`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_MEDIA_BYTES) throw new Error(`素材超过单次上限（${MAX_MEDIA_BYTES} 字节）`);
  const mime = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  return `data:${mime};base64,${buffer.toString('base64')}`;
};

const TOOLS = [
  {
    name: 'bb_agent_status',
    description: '检查 BigBanana 原生画布桥接状态：3005 生产服务是否在线、页面是否已连接、是否有挂起命令。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bb_api_status',
    description: '检查 BigBanana 生产服务 HTTP 状态，合并返回 /healthz 与 /api/new-api/status。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bb_api_request',
    description: '向 BigBanana 本地 HTTP 服务发送请求（仅允许 /healthz 与 /api/new-api/ 前缀）。',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP 方法，默认 GET' },
        path: { type: 'string', description: '请求路径，必须以 /healthz 或 /api/new-api/ 开头' },
        body: { type: 'object', description: 'POST 请求请求体' },
        timeoutMs: { type: 'number', description: '超时时间（毫秒），默认 10000' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'bb_list_projects',
    description: '列出浏览器 IndexedDB（BigBananaDB）中的全部项目/分集，含镜头数量、阶段与画布图是否存在。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bb_get_project',
    description: '读取单个项目的结构摘要与分镜清单（镜头 ID、标题、景别、运镜、首尾帧状态），用于确定导入/投影目标。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: '项目/分集 ID（ep_*）' } },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'bb_get_canvas',
    description: '读取某分集某模态的 v4 画布图（节点、连线、视口、updatedAt）。画布不存在时返回 exists=false。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        mode: { type: 'string', enum: ['image', 'video'] },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'bb_project_to_canvas',
    description: '把导演台的分镜/关键帧/资产按 1:1 契约投影到画布（幂等，保留本地排版）。相当于在画布 UI 里点「投影」。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        mode: { type: 'string', enum: ['image', 'video', 'all'], description: '默认 image' },
        scope: { type: 'string', enum: ['episode', 'shot'], description: '默认 episode' },
        targetShotId: { type: 'string', description: 'scope=shot 时聚焦的镜头 ID' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'bb_upsert_node',
    description: '在画布上新建或更新节点（reference_slot 参考图槽 / config_node 参数卡 / artifact_output 产物 / shot_projection 投影）。写入 IndexedDB 的 v4 画布图。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        mode: { type: 'string', enum: ['image', 'video'] },
        expectedUpdatedAt: { type: 'number', description: '可选乐观锁：与当前画布 updatedAt 不一致则拒绝' },
        node: {
          type: 'object',
          description: '节点实体；缺省 id/graphId 由服务端补齐',
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: ['shot_projection', 'config_node', 'reference_slot', 'generation_task', 'artifact_output'] },
            position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
            size: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } },
            data: { type: 'object' },
            sourceRef: { type: 'object' },
          },
          required: ['type'],
          additionalProperties: true,
        },
        connectToNodeId: { type: 'string', description: '可选：自动连一条边到该节点' },
        sourceHandle: { type: 'string', description: '默认 output-image' },
        targetHandle: { type: 'string', description: '默认 slot-1' },
      },
      required: ['projectId', 'mode', 'node'],
      additionalProperties: false,
    },
  },
  {
    name: 'bb_remove_node',
    description: '从画布图删除指定节点，并自动清理与之相连的边。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        mode: { type: 'string', enum: ['image', 'video'] },
        nodeId: { type: 'string' },
      },
      required: ['projectId', 'mode', 'nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'bb_import_asset',
    description: '把外部资料（URL 或 dataUrl）导入项目资产库，可同时落成画布上的 reference_slot 节点。这是「Scrapling 收集资料 → 导入导演台/画布」的原生入口。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        kind: { type: 'string', enum: ['character', 'scene', 'prop'] },
        name: { type: 'string' },
        url: { type: 'string', description: '远程素材地址（由本机 Node 下载后转 data URL）' },
        dataUrl: { type: 'string', description: '直接传入 data:*;base64 内容' },
        visualPrompt: { type: 'string' },
        mode: { type: 'string', enum: ['image', 'video'], description: 'createNode 时落到哪个画布' },
        createNode: { type: 'boolean', description: '是否同时创建画布 reference_slot 节点' },
        position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
      },
      required: ['projectId', 'kind', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'bb_list_assets',
    description: '列出资产库条目（角色/场景/道具），含是否已有参考图与更新时间。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '默认 50' } },
      additionalProperties: false,
    },
  },
];

const textResult = (payload) => ({
  content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
  isError: false,
});

const errorResult = (error) => ({
  content: [{ type: 'text', text: `错误：${error && error.message ? error.message : String(error)}` }],
  isError: true,
});

const callTool = async (name, args = {}) => {
  switch (name) {
    case 'bb_agent_status':
      return agentStatus();
    case 'bb_api_status':
      return apiStatus();
    case 'bb_api_request':
      return apiRequest(args);
    case 'bb_list_projects':
      return rpc('project.list');
    case 'bb_get_project':
      return rpc('project.get', { projectId: args.projectId });
    case 'bb_get_canvas':
      return rpc('canvas.get', { projectId: args.projectId, mode: args.mode || 'image' });
    case 'bb_project_to_canvas':
      return rpc(
        'canvas.projection',
        {
          projectId: args.projectId,
          mode: args.mode || 'image',
          scope: args.scope || 'episode',
          targetShotId: args.targetShotId,
        },
        45000
      );
    case 'bb_upsert_node':
      return rpc('canvas.upsertNode', {
        projectId: args.projectId,
        mode: args.mode,
        node: args.node,
        expectedUpdatedAt: args.expectedUpdatedAt,
        connectToNodeId: args.connectToNodeId,
        sourceHandle: args.sourceHandle,
        targetHandle: args.targetHandle,
      });
    case 'bb_remove_node':
      return rpc('canvas.removeNode', {
        projectId: args.projectId,
        mode: args.mode,
        nodeId: args.nodeId,
      });
    case 'bb_import_asset': {
      const media = await resolveMedia(args);
      return rpc(
        'asset.import',
        {
          projectId: args.projectId,
          kind: args.kind,
          name: args.name,
          dataUrl: media,
          visualPrompt: args.visualPrompt,
          mode: args.mode,
          createNode: args.createNode === true,
          position: args.position,
        },
        60000
      );
    }
    case 'bb_list_assets': {
      const result = await rpc('asset.list');
      const limit = Math.max(1, Math.min(Number(args.limit) || 50, 500));
      return Array.isArray(result) ? result.slice(0, limit) : result;
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
};

const writeMessage = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const handleMessage = async (message) => {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  try {
    if (method === 'initialize') {
      const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION;
      const result = {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'BigBanana 原生画布 MCP：直接读写本机 3005 页面的真实 IndexedDB。所有写操作先读后写，可通过 expectedUpdatedAt 做乐观锁。',
      };
      if (!isNotification) writeMessage({ jsonrpc: '2.0', id, result });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') {
      if (!isNotification) writeMessage({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      if (!isNotification) writeMessage({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        const payload = await callTool(name, args);
        if (!isNotification) writeMessage({ jsonrpc: '2.0', id, result: textResult(payload) });
      } catch (error) {
        log('tool failed', name, error && error.message);
        if (!isNotification) writeMessage({ jsonrpc: '2.0', id, result: errorResult(error) });
      }
      return;
    }
    if (!isNotification) {
      writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (error) {
    if (!isNotification) {
      writeMessage({ jsonrpc: '2.0', id, error: { code: -32603, message: error && error.message ? error.message : String(error) } });
    }
  }
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    log('忽略非 JSON 行');
    return;
  }
  if (Array.isArray(message)) {
    for (const item of message) void handleMessage(item);
    return;
  }
  void handleMessage(message);
});
rl.on('close', () => process.exit(0));

log(`ready root=${ROOT} state=${STATE_FILE}`);
