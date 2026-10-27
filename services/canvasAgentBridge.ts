/**
 * BigBanana 浏览器侧画布桥接客户端（原生、无云端依赖）
 *
 * 页面首次加载后通过同源 SSE 接入 3005 生产服务内置的 /api/agent/stream，
 * 接收 MCP 下发的命令，直接调用应用自己的 storageService / projectionService，
 * 读写「真实页面 + 真实 IndexedDB」，因此不会出现新开空浏览器导致数据看不见的问题。
 */
import {
  getAllAssetLibraryItems,
  getAllProjectsMetadata,
  getCanvasGraph,
  loadProjectFromDB,
  saveAssetToLibrary,
  saveCanvasGraph,
} from '../services/storageService';
import { projectEpisodeToCanvas } from '../features/interop/projectionService';
import { DEFAULT_VIEWPORT } from '../components/canvas/canvasConstants';
import type {
  AssetLibraryItem,
  CanvasEdgeEntity,
  CanvasGraphEntity,
  CanvasNodeEntity,
  CanvasNodeType,
  Character,
  Episode,
  Prop,
  Scene,
} from '../types';

type CanvasMode = 'image' | 'video';

interface AgentCommand {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface BridgeRuntime {
  connected: boolean;
  nonce: string;
  commandCount: number;
  lastError?: string;
  lastCommandAt?: number;
}

const runtime: BridgeRuntime = { connected: false, nonce: '', commandCount: 0 };
let started = false;

const makeId = (prefix: string): string => {
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${uuid}`;
};

const truncateDeep = (value: unknown, max = 480): unknown => {
  if (typeof value === 'string') {
    if (value.length <= max) return value;
    return `${value.slice(0, Math.floor(max / 2))}…[truncated ${value.length} chars]`;
  }
  if (Array.isArray(value)) return value.map((item) => truncateDeep(item, max));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = truncateDeep(item, max);
    }
    return out;
  }
  return value;
};

const parseMode = (value: unknown): CanvasMode => (value === 'video' ? 'video' : 'image');

const createEmptyGraph = (episodeId: string, mode: CanvasMode): CanvasGraphEntity => ({
  id: makeId('cgraph'),
  episodeId,
  mode,
  viewport: { ...DEFAULT_VIEWPORT },
  nodes: [],
  edges: [],
  updatedAt: Date.now(),
});

const loadGraphOrCreate = async (episodeId: string, mode: CanvasMode): Promise<CanvasGraphEntity> =>
  (await getCanvasGraph(episodeId, mode)) || createEmptyGraph(episodeId, mode);

const summarizeEpisode = (episode: Episode) => ({
  id: episode.id,
  title: episode.title,
  seriesId: episode.seriesId,
  episodeNumber: episode.episodeNumber,
  stage: episode.stage,
  lastModified: episode.lastModified,
  shotCount: Array.isArray(episode.shots) ? episode.shots.length : 0,
  characters: episode.scriptData?.characters?.length ?? 0,
  scenes: episode.scriptData?.scenes?.length ?? 0,
  props: episode.scriptData?.props?.length ?? 0,
  hasScript: Boolean(episode.scriptData),
  canvas: {
    image: Boolean(episode.imageCanvas),
    video: Boolean(episode.videoCanvas),
  },
});

const normalizeNode = (graph: CanvasGraphEntity, raw: Record<string, unknown>): CanvasNodeEntity => {
  const rawId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : makeId('cnode');
  const position = (raw.position as { x?: number; y?: number } | undefined) || { x: 0, y: 0 };
  const size = raw.size as { width?: number; height?: number } | undefined;
  return {
    id: rawId.startsWith('cnode-') ? rawId : rawId,
    graphId: graph.id,
    type: (raw.type as CanvasNodeType) || 'reference_slot',
    position: { x: Number(position.x) || 0, y: Number(position.y) || 0 },
    ...(size ? { size: { width: Number(size.width) || 240, height: Number(size.height) || 180 } } : {}),
    data: (raw.data as Record<string, unknown>) || {},
    ...(raw.sourceRef ? { sourceRef: raw.sourceRef as CanvasNodeEntity['sourceRef'] } : {}),
  };
};

const buildAssetLibraryItem = (params: {
  projectId: string;
  kind: 'character' | 'scene' | 'prop';
  name: string;
  dataUrl: string;
  visualPrompt?: string;
  projectName?: string;
}): AssetLibraryItem => {
  const now = Date.now();
  const id = makeId('asset');
  const common = {
    id,
    visualPrompt: params.visualPrompt,
    referenceImage: params.dataUrl,
    status: 'completed' as const,
    version: 1,
  };
  let data: Character | Scene | Prop;
  if (params.kind === 'character') {
    data = { id, name: params.name, gender: '', age: '', personality: '', variations: [], ...common } as Character;
  } else if (params.kind === 'scene') {
    data = { id, location: params.name, time: '', atmosphere: '', ...common } as Scene;
  } else {
    data = { id, name: params.name, category: '', description: '', ...common } as Prop;
  }
  return {
    id,
    type: params.kind,
    name: params.name,
    projectId: params.projectId,
    projectName: params.projectName,
    createdAt: now,
    updatedAt: now,
    data,
  };
};

const handleCommand = async (command: AgentCommand): Promise<unknown> => {
  const params = command.params || {};
  const mode = parseMode(params.mode);

  switch (command.method) {
    case 'agent.ping':
      return { pong: true, at: Date.now() };

    case 'project.list': {
      const episodes = await getAllProjectsMetadata();
      return episodes
        .map((episode) => {
          const summary = summarizeEpisode(episode);
          return {
            ...summary,
            canvas: {
              image: Boolean(episode.imageCanvas),
              video: Boolean(episode.videoCanvas),
            },
          };
        })
        .sort((a, b) => b.lastModified - a.lastModified);
    }

    case 'project.get': {
      const projectId = String(params.projectId || '');
      if (!projectId) throw new Error('缺少 projectId');
      const episode = await loadProjectFromDB(projectId);
      return {
        ...summarizeEpisode(episode),
        visualStyle: episode.visualStyle,
        targetDuration: episode.targetDuration,
        language: episode.language,
        shots: (episode.shots || []).map((shot) => ({
          id: shot.id,
          sceneId: shot.sceneId,
          actionSummary: shot.actionSummary,
          shotSize: shot.shotSize,
          cameraMovement: shot.cameraMovement,
          dialogue: shot.dialogue,
          keyframes: (shot.keyframes || []).map((keyframe) => ({
            id: keyframe.id,
            type: keyframe.type,
            status: keyframe.status,
            hasImage: Boolean(keyframe.imageUrl),
            visualPrompt: keyframe.visualPrompt,
          })),
          video: shot.interval
            ? {
                duration: shot.interval.duration,
                hasVideo: Boolean(shot.interval.videoUrl),
                videoPrompt: shot.interval.videoPrompt,
              }
            : null,
        })),
      };
    }

    case 'canvas.get': {
      const projectId = String(params.projectId || '');
      if (!projectId) throw new Error('缺少 projectId');
      const graph = await getCanvasGraph(projectId, mode);
      if (!graph) return { exists: false, projectId, mode };
      return {
        exists: true,
        graphId: graph.id,
        projectId,
        mode: graph.mode,
        updatedAt: graph.updatedAt,
        viewport: graph.viewport,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        nodes: truncateDeep(graph.nodes),
        edges: graph.edges,
      };
    }

    case 'canvas.upsertNode': {
      const projectId = String(params.projectId || '');
      if (!projectId) throw new Error('缺少 projectId');
      const rawNode = params.node as Record<string, unknown> | undefined;
      if (!rawNode) throw new Error('缺少 node');
      const graph = await loadGraphOrCreate(projectId, mode);
      const expected = params.expectedUpdatedAt;
      if (typeof expected === 'number' && graph.nodes.length > 0 && graph.updatedAt !== expected) {
        throw Object.assign(new Error('画布已被修改（updatedAt 不一致），请先重新读取再写入'), { code: 'STALE_GRAPH' });
      }
      const node = normalizeNode(graph, rawNode);
      const index = graph.nodes.findIndex((item) => item.id === node.id);
      if (index >= 0) graph.nodes[index] = node;
      else graph.nodes.push(node);

      const connectToNodeId = params.connectToNodeId;
      if (typeof connectToNodeId === 'string' && connectToNodeId) {
        const edge: CanvasEdgeEntity = {
          id: makeId('edge'),
          sourceNodeId: node.id,
          sourceHandle: String(params.sourceHandle || 'output-image'),
          targetNodeId: connectToNodeId,
          targetHandle: String(params.targetHandle || 'slot-1'),
        };
        graph.edges.push(edge);
      }
      await saveCanvasGraph(graph);
      return {
        ok: true,
        graphId: graph.id,
        nodeId: node.id,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        updatedAt: graph.updatedAt,
      };
    }

    case 'canvas.removeNode': {
      const projectId = String(params.projectId || '');
      const nodeId = String(params.nodeId || '');
      if (!projectId || !nodeId) throw new Error('缺少 projectId 或 nodeId');
      const graph = await loadGraphOrCreate(projectId, mode);
      const before = graph.nodes.length;
      graph.nodes = graph.nodes.filter((node) => node.id !== nodeId);
      graph.edges = graph.edges.filter((edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId);
      if (graph.nodes.length === before) {
        return { ok: false, removed: false, reason: 'NODE_NOT_FOUND', nodeId };
      }
      await saveCanvasGraph(graph);
      return { ok: true, removed: true, nodeId, nodeCount: graph.nodes.length, edgeCount: graph.edges.length };
    }

    case 'canvas.projection': {
      const projectId = String(params.projectId || '');
      if (!projectId) throw new Error('缺少 projectId');
      const episode = await loadProjectFromDB(projectId);
      const projectionMode = params.mode === 'video' || params.mode === 'all' ? params.mode : 'image';
      const scope = params.scope === 'shot' ? 'shot' : 'episode';
      const result = await projectEpisodeToCanvas(episode, projectionMode, {
        scope,
        targetShotId: typeof params.targetShotId === 'string' ? params.targetShotId : undefined,
      });
      return {
        ok: true,
        graphId: result.graph.id,
        nodeCount: result.graph.nodes.length,
        createdNodeIds: result.createdNodeIds,
        focusedNodeId: result.focusedNodeId,
      };
    }

    case 'asset.import': {
      const projectId = String(params.projectId || '');
      const kind = params.kind === 'scene' || params.kind === 'prop' ? params.kind : 'character';
      const name = String(params.name || '').trim();
      const dataUrl = String(params.dataUrl || '');
      if (!projectId || !name || !dataUrl) throw new Error('asset.import 需要 projectId / name / dataUrl');
      let projectName: string | undefined;
      try {
        const episode = await loadProjectFromDB(projectId);
        projectName = episode.title;
      } catch {
        projectName = undefined;
      }
      const item = buildAssetLibraryItem({
        projectId,
        kind,
        name,
        dataUrl,
        visualPrompt: typeof params.visualPrompt === 'string' ? params.visualPrompt : undefined,
        projectName,
      });
      await saveAssetToLibrary(item);

      let nodeId: string | undefined;
      if (params.createNode === true) {
        const graph = await loadGraphOrCreate(projectId, mode);
        const position = (params.position as { x?: number; y?: number } | undefined) || { x: 0, y: 0 };
        const node = normalizeNode(graph, {
          type: 'reference_slot',
          position: { x: Number(position.x) || 0, y: Number(position.y) || 0 },
          data: {
            assetId: item.id,
            assetType: kind,
            name,
            imageUrl: dataUrl,
            visualPrompt: params.visualPrompt,
          },
        });
        graph.nodes.push(node);
        await saveCanvasGraph(graph);
        nodeId = node.id;
      }
      return { ok: true, assetId: item.id, kind, name, hasImage: true, nodeId };
    }

    case 'asset.list': {
      const items = await getAllAssetLibraryItems();
      return items.map((item) => ({
        id: item.id,
        type: item.type,
        name: item.name,
        projectId: item.projectId,
        projectName: item.projectName,
        updatedAt: item.updatedAt,
        hasImage: Boolean(item.data && (item.data as Character | Scene | Prop).referenceImage),
      }));
    }

    default:
      throw Object.assign(new Error(`未知命令：${command.method}`), { code: 'UNKNOWN_METHOD' });
  }
};

const postResult = async (payload: Record<string, unknown>) => {
  const response = await fetch('/api/agent/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`回传结果失败 HTTP ${response.status} ${text}`);
  }
};

const onCommand = async (command: AgentCommand) => {
  runtime.commandCount += 1;
  runtime.lastCommandAt = Date.now();
  try {
    const result = await handleCommand(command);
    await postResult({ nonce: runtime.nonce, id: command.id, ok: true, result });
  } catch (error) {
    const message = error && (error as Error).message ? (error as Error).message : String(error);
    const code = error && (error as { code?: string }).code ? (error as { code?: string }).code : 'COMMAND_FAILED';
    runtime.lastError = message;
    console.error('[canvas-agent] command failed', command.method, message);
    await postResult({ nonce: runtime.nonce, id: command.id, ok: false, error: { code, message } }).catch((postError) => {
      console.error('[canvas-agent] failed to report error', postError);
    });
  }
};

export const startCanvasAgentBridge = (): void => {
  if (started) return;
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
  // 只绑定本机 3005 正式服务，避免开发态或外部访问时无谓重连
  if (window.location.port !== '3005') return;
  started = true;

  const source = new EventSource('/api/agent/stream');

  source.addEventListener('hello', (event: MessageEvent) => {
    try {
      const payload = JSON.parse(event.data) as { nonce?: string };
      runtime.nonce = payload.nonce || '';
      runtime.connected = true;
      console.info('[canvas-agent] bridge connected');
    } catch (error) {
      console.error('[canvas-agent] bad hello payload', error);
    }
  });

  source.addEventListener('command', (event: MessageEvent) => {
    let command: AgentCommand;
    try {
      command = JSON.parse(event.data) as AgentCommand;
    } catch (error) {
      console.error('[canvas-agent] bad command payload', error);
      return;
    }
    void onCommand(command);
  });

  source.addEventListener('error', () => {
    runtime.connected = false;
    runtime.lastError = 'SSE 连接中断，正在自动重连';
  });

  (window as unknown as { __BB_CANVAS_AGENT__: BridgeRuntime & { started: boolean } }).__BB_CANVAS_AGENT__ = Object.assign(runtime, { started: true });
};
