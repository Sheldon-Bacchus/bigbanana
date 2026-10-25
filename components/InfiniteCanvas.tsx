import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Focus,
  Image as ImageIcon,
  Maximize2,
  Minus,
  Move,
  Plus,
  Video as VideoIcon,
  X,
} from 'lucide-react';
import { MediaCanvasState, MediaCanvasViewport, ProjectState } from '../types';

type CanvasMode = 'image' | 'video';
type CanvasEntryMode = CanvasMode | 'all';
type CanvasNodeKind = 'reference' | 'shot' | 'image' | 'video';

interface InfiniteCanvasProps {
  project: ProjectState;
  initialMode?: CanvasEntryMode;
  onClose: () => void;
  onOpenShot?: (shotId: string) => void;
  onChange: (mode: CanvasMode, state: MediaCanvasState) => void;
}

interface CanvasNodeModel {
  id: string;
  kind: CanvasNodeKind;
  title: string;
  subtitle: string;
  status: string;
  imageUrl?: string;
  videoUrl?: string;
  shotId?: string;
  x: number;
  y: number;
}

interface CanvasEdge {
  from: string;
  to: string;
}

interface DragState {
  type: 'canvas' | 'node';
  nodeId?: string;
  startX: number;
  startY: number;
  startViewport?: MediaCanvasViewport;
  startNode?: { x: number; y: number };
}

const NODE_WIDTH = 238;
const NODE_HEIGHT = 176;
const REFERENCE_NODE_HEIGHT = 238;
const WORLD_WIDTH = 1500;
const WORLD_HEIGHT = 980;
const DEFAULT_VIEWPORT: MediaCanvasViewport = { x: 28, y: 24, zoom: 0.76 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const getStartFrame = (shot: ProjectState['shots'][number]) =>
  shot.keyframes?.find((keyframe) => keyframe.type === 'start');

const getImageStatus = (shot: ProjectState['shots'][number]) => {
  const frame = getStartFrame(shot);
  if (frame?.imageUrl) return '已生成';
  if (frame?.status === 'generating') return '生成中';
  if (frame?.status === 'failed') return '生成失败';
  return '待生成';
};

const getVideoStatus = (shot: ProjectState['shots'][number]) => {
  if (shot.interval?.videoUrl) return '已生成';
  if (shot.interval?.status === 'generating') return '生成中';
  if (shot.interval?.status === 'failed') return '生成失败';
  return '待生成';
};

const resolvePosition = (
  state: MediaCanvasState | undefined,
  id: string,
  fallback: { x: number; y: number }
) => state?.nodePositions?.[id] || fallback;

const getReferenceImage = (project: ProjectState): string | undefined => {
  const candidates = [
    ...(project.scriptData?.characters || []).map((character) => character.referenceImage),
    ...(project.scriptData?.scenes || []).map((scene) => scene.referenceImage),
    ...(project.scriptData?.props || []).map((prop) => prop.referenceImage),
  ];
  return candidates.find((image): image is string => Boolean(image));
};

const buildCanvasGraph = (
  project: ProjectState,
  mode: CanvasMode,
  state: MediaCanvasState | undefined
): { nodes: CanvasNodeModel[]; edges: CanvasEdge[] } => {
  const nodes: CanvasNodeModel[] = [];
  const edges: CanvasEdge[] = [];
  const shots = project.shots || [];
  const referenceCount =
    (project.scriptData?.characters?.length || 0) +
    (project.scriptData?.scenes?.length || 0) +
    (project.scriptData?.props?.length || 0);

  const referenceId = `reference-bundle-${mode}`;
  nodes.push({
    id: referenceId,
    kind: 'reference',
    title: mode === 'image' ? '图像参考资产' : '视频输入参考',
    subtitle: `${referenceCount} 项角色 / 场景 / 道具绑定`,
    status: '只读上下文',
    imageUrl: getReferenceImage(project),
    ...resolvePosition(state, referenceId, { x: 34, y: 42 }),
  });

  shots.forEach((shot, index) => {
    const row = index % 3;
    const columnOffset = Math.floor(index / 3) * 34;
    const y = 42 + row * 260;
    const shotId = `shot-${shot.id}`;
    const imageId = `image-${shot.id}`;
    const videoId = `video-${shot.id}`;
    const startFrame = getStartFrame(shot);
    const shotPosition = resolvePosition(state, shotId, { x: 320 + columnOffset, y });

    nodes.push({
      id: shotId,
      kind: 'shot',
      title: `SHOT ${String(index + 1).padStart(3, '0')}`,
      subtitle: shot.cameraMovement || '未设置运镜',
      status: shot.actionSummary ? '镜头提示词已绑定' : '缺少动作描述',
      shotId: shot.id,
      ...shotPosition,
    });
    edges.push({ from: referenceId, to: shotId });

    const imagePosition = resolvePosition(state, imageId, { x: 610 + columnOffset, y });
    nodes.push({
      id: imageId,
      kind: 'image',
      title: '生图 / 关键帧',
      subtitle: startFrame?.visualPrompt || '提示词会从镜头动作与资产上下文生成',
      status: getImageStatus(shot),
      imageUrl: startFrame?.imageUrl,
      shotId: shot.id,
      ...imagePosition,
    });
    edges.push({ from: shotId, to: imageId });

    if (mode === 'video') {
      const videoPosition = resolvePosition(state, videoId, { x: 900 + columnOffset, y });
      nodes.push({
        id: videoId,
        kind: 'video',
        title: '生视频',
        subtitle: shot.interval?.videoPrompt || '视频运动提示词待确认',
        status: getVideoStatus(shot),
        videoUrl: shot.interval?.videoUrl,
        shotId: shot.id,
        ...videoPosition,
      });
      edges.push({ from: imageId, to: videoId });
    }
  });

  return { nodes, edges };
};

const statusClass = (status: string) => {
  if (status === '已生成' || status === '镜头提示词已绑定') {
    return 'text-[var(--success-text)] border-[var(--success-border)] bg-[var(--success-bg)]';
  }
  if (status === '生成中') {
    return 'text-[var(--warning-text)] border-[var(--warning-border)] bg-[var(--warning-bg)]';
  }
  if (status === '生成失败' || status === '缺少动作描述') {
    return 'text-[var(--error-text)] border-[var(--error-border)] bg-[var(--error-hover-bg)]';
  }
  return 'text-[var(--text-muted)] border-[var(--border-primary)] bg-[var(--bg-hover)]';
};

const nodeAccentClass: Record<CanvasNodeKind, string> = {
  reference: 'border-amber-400/50 bg-amber-400/[0.06]',
  shot: 'border-[var(--border-secondary)] bg-[var(--bg-surface)]',
  image: 'border-violet-400/50 bg-violet-400/[0.06]',
  video: 'border-emerald-400/50 bg-emerald-400/[0.06]',
};

const nodeIcon = (kind: CanvasNodeKind) => {
  if (kind === 'image') return <ImageIcon className="h-3.5 w-3.5" />;
  if (kind === 'video') return <VideoIcon className="h-3.5 w-3.5" />;
  if (kind === 'reference') return <Focus className="h-3.5 w-3.5" />;
  return <Move className="h-3.5 w-3.5" />;
};

const CanvasNodeCard: React.FC<{
  node: CanvasNodeModel;
  selected: boolean;
  onSelect: () => void;
  onOpenShot?: (shotId: string) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}> = ({ node, selected, onSelect, onOpenShot, onPointerDown }) => (
  <div
    data-canvas-node="true"
    className={`absolute w-[238px] overflow-hidden rounded-xl border shadow-xl backdrop-blur-sm transition-shadow ${nodeAccentClass[node.kind]} ${selected ? 'ring-2 ring-[var(--accent)] shadow-[var(--accent-shadow)]' : ''}`}
    style={{ left: node.x, top: node.y, height: node.kind === 'reference' ? REFERENCE_NODE_HEIGHT : NODE_HEIGHT }}
    onPointerDown={onPointerDown}
    onClick={(event) => {
      event.stopPropagation();
      onSelect();
    }}
  >
    <div className="flex h-10 items-center gap-2 border-b border-[var(--border-primary)] bg-[var(--bg-elevated)]/85 px-3">
      <span className="text-[var(--accent-text)]">{nodeIcon(node.kind)}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[10px] font-bold uppercase tracking-widest text-[var(--text-primary)]">{node.title}</p>
        <p className="truncate text-[9px] font-mono text-[var(--text-muted)]">{node.subtitle}</p>
      </div>
      <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[8px] font-mono ${statusClass(node.status)}`}>{node.status}</span>
    </div>

    <div className="p-3">
      {node.kind === 'reference' && (
        <div className="space-y-2">
          <div className="grid grid-cols-4 gap-1">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="aspect-square overflow-hidden rounded border border-[var(--border-primary)] bg-[var(--bg-base)]">
                {index === 0 && node.imageUrl ? (
                  <img src={node.imageUrl} alt="参考资产" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-[9px] text-[var(--text-muted)]">REF</div>
                )}
              </div>
            ))}
          </div>
          <p className="text-[10px] leading-relaxed text-[var(--text-tertiary)]">
            角色、场景、道具和视觉风格在这里作为生成上下文展示；不在画布内上传或替换模型。
          </p>
        </div>
      )}

      {node.kind === 'shot' && (
        <div className="space-y-2">
          <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-base)] p-2 text-[10px] leading-relaxed text-[var(--text-secondary)]">
            {node.subtitle === '未设置运镜' ? '镜头动作摘要会在这里作为下游生图/生视频的共同输入。' : '动作、台词、资产绑定和镜头运动已汇入此节点。'}
          </div>
          {node.shotId && onOpenShot && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpenShot(node.shotId!);
              }}
              className="inline-flex items-center gap-1 rounded border border-[var(--accent-border)] bg-[var(--accent-bg)] px-2 py-1 text-[9px] font-bold text-[var(--accent-text)] hover:bg-[var(--accent-bg-strong)]"
            >
              打开镜头工作台 <ArrowRight className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {node.kind === 'image' && (
        <div className="aspect-[16/9] overflow-hidden rounded-lg border border-[var(--border-primary)] bg-[var(--bg-base)]">
          {node.imageUrl ? (
            <img src={node.imageUrl} alt={node.title} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-[10px] text-[var(--text-muted)]">
              <ImageIcon className="h-5 w-5 opacity-60" />
              <span>PREVIEW AREA</span>
            </div>
          )}
        </div>
      )}

      {node.kind === 'video' && (
        <div className="aspect-[16/9] overflow-hidden rounded-lg border border-[var(--border-primary)] bg-[var(--bg-base)]">
          {node.videoUrl ? (
            <video src={node.videoUrl} controls muted className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-[10px] text-[var(--text-muted)]">
              <VideoIcon className="h-5 w-5 opacity-60" />
              <span>VIDEO PREVIEW</span>
            </div>
          )}
        </div>
      )}
    </div>
  </div>
);

const InfiniteCanvas: React.FC<InfiniteCanvasProps> = ({
  project,
  initialMode = 'all',
  onClose,
  onOpenShot,
  onChange,
}) => {
  const [activeMode, setActiveMode] = useState<CanvasMode>(initialMode === 'video' ? 'video' : 'image');
  const activeState = activeMode === 'image' ? project.imageCanvas : project.videoCanvas;
  const [viewport, setViewport] = useState<MediaCanvasViewport>(activeState?.viewport || DEFAULT_VIEWPORT);
  const [nodePositions, setNodePositions] = useState(activeState?.nodePositions || {});
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const graph = useMemo(() => {
    const state: MediaCanvasState = {
      version: 1,
      mode: 'inspect-only',
      viewport,
      nodePositions,
      updatedAt: Date.now(),
    };
    return buildCanvasGraph(project, activeMode, state);
  }, [project, activeMode, viewport, nodePositions]);

  const nodeMap = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

  useEffect(() => {
    const nextState = activeMode === 'image' ? project.imageCanvas : project.videoCanvas;
    setViewport(nextState?.viewport || DEFAULT_VIEWPORT);
    setNodePositions(nextState?.nodePositions || {});
    setSelectedNodeId(null);
  }, [activeMode, project.id]);

  useEffect(() => {
    const state: MediaCanvasState = {
      version: 1,
      mode: 'inspect-only',
      viewport,
      nodePositions,
      updatedAt: Date.now(),
    };
    onChange(activeMode, state);
    // Persist only after the local canvas state changes. The parent already
    // debounces the project save, so this remains cheap during a drag.
  }, [activeMode, viewport, nodePositions]);

  const updateViewport = (next: MediaCanvasViewport) => {
    setViewport({
      x: next.x,
      y: next.y,
      zoom: clamp(next.zoom, 0.45, 1.35),
    });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-canvas-node="true"]')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      type: 'canvas',
      startX: event.clientX,
      startY: event.clientY,
      startViewport: viewport,
    };
  };

  const handleNodePointerDown = (node: CanvasNodeModel, event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedNodeId(node.id);
    dragRef.current = {
      type: 'node',
      nodeId: node.id,
      startX: event.clientX,
      startY: event.clientY,
      startNode: { x: node.x, y: node.y },
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.type === 'canvas' && drag.startViewport) {
      updateViewport({
        ...drag.startViewport,
        x: drag.startViewport.x + event.clientX - drag.startX,
        y: drag.startViewport.y + event.clientY - drag.startY,
      });
      return;
    }
    if (drag.type === 'node' && drag.nodeId && drag.startNode) {
      setNodePositions((previous) => ({
        ...previous,
        [drag.nodeId!]: {
          x: Math.max(8, drag.startNode!.x + (event.clientX - drag.startX) / viewport.zoom),
          y: Math.max(8, drag.startNode!.y + (event.clientY - drag.startY) / viewport.zoom),
        },
      }));
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const direction = event.deltaY > 0 ? -0.05 : 0.05;
    updateViewport({ ...viewport, zoom: viewport.zoom + direction });
  };

  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) : undefined;
  const generatedCount = graph.nodes.filter((node) => node.status === '已生成').length;
  const outputCount = graph.nodes.filter((node) => node.kind === 'image' || node.kind === 'video').length;

  return (
    <div className="absolute inset-0 z-[60] flex min-w-0 flex-col bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--border-primary)] bg-[var(--bg-elevated)] px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Maximize2 className="h-5 w-5 text-[var(--accent)]" />
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold text-[var(--text-primary)]">无限画布</h2>
            <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--text-muted)]">INFINITE CANVAS · INSPECT ONLY</p>
          </div>
          <span className="hidden rounded border border-[var(--warning-border)] bg-[var(--warning-bg)] px-2 py-1 text-[9px] font-mono text-[var(--warning-text)] lg:inline-flex">
            不上模型 · 只做可视化编排
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-surface)] p-1">
            <button
              type="button"
              onClick={() => setActiveMode('image')}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider ${activeMode === 'image' ? 'bg-[var(--accent-bg)] text-[var(--accent-text)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'}`}
            >
              <ImageIcon className="h-3.5 w-3.5" /> 生图画布
            </button>
            <button
              type="button"
              onClick={() => setActiveMode('video')}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider ${activeMode === 'video' ? 'bg-[var(--accent-bg)] text-[var(--accent-text)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'}`}
            >
              <VideoIcon className="h-3.5 w-3.5" /> 生视频画布
            </button>
          </div>
          <button type="button" onClick={() => updateViewport({ ...viewport, zoom: viewport.zoom - 0.1 })} className="rounded border border-[var(--border-primary)] p-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" title="缩小">
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="w-12 text-center font-mono text-[10px] text-[var(--text-muted)]">{Math.round(viewport.zoom * 100)}%</span>
          <button type="button" onClick={() => updateViewport({ ...viewport, zoom: viewport.zoom + 0.1 })} className="rounded border border-[var(--border-primary)] p-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" title="放大">
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => { setViewport(DEFAULT_VIEWPORT); setSelectedNodeId(null); }} className="rounded border border-[var(--border-primary)] p-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" title="重置视图">
            <Focus className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={onClose} className="rounded border border-[var(--border-primary)] p-2 text-[var(--text-tertiary)] hover:bg-[var(--error-hover-bg)] hover:text-[var(--error-text)]" title="关闭无限画布">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          className="relative min-w-0 flex-1 cursor-grab overflow-hidden bg-[var(--bg-base)] active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
          onClick={() => setSelectedNodeId(null)}
        >
          <div className="pointer-events-none absolute inset-0 opacity-60" style={{ backgroundImage: 'radial-gradient(circle, var(--border-primary) 1px, transparent 1px)', backgroundSize: '22px 22px' }} />
          <div className="absolute left-4 top-4 z-10 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-surface)]/90 px-3 py-2 text-[10px] text-[var(--text-muted)] shadow-lg backdrop-blur">
            拖拽空白处平移 · 拖拽节点整理关系 · 滚轮缩放
          </div>

          <div
            className="absolute left-0 top-0"
            style={{ width: WORLD_WIDTH, height: WORLD_HEIGHT, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`, transformOrigin: 'top left' }}
          >
            <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`} aria-hidden="true">
              {graph.edges.map((edge) => {
                const from = nodeMap.get(edge.from);
                const to = nodeMap.get(edge.to);
                if (!from || !to) return null;
                const startX = from.x + NODE_WIDTH;
                const startY = from.y + 88;
                const endX = to.x;
                const endY = to.y + 88;
                const control = Math.max(60, Math.abs(endX - startX) * 0.45);
                return (
                  <path
                    key={`${edge.from}-${edge.to}`}
                    d={`M ${startX} ${startY} C ${startX + control} ${startY}, ${endX - control} ${endY}, ${endX} ${endY}`}
                    fill="none"
                    stroke="var(--border-secondary)"
                    strokeWidth="2"
                    strokeDasharray="5 5"
                    opacity="0.8"
                  />
                );
              })}
            </svg>

            {graph.nodes.map((node) => (
              <CanvasNodeCard
                key={node.id}
                node={node}
                selected={selectedNodeId === node.id}
                onSelect={() => setSelectedNodeId(node.id)}
                onOpenShot={onOpenShot}
                onPointerDown={(event) => handleNodePointerDown(node, event)}
              />
            ))}
          </div>
        </div>

        <aside className="hidden w-64 shrink-0 border-l border-[var(--border-primary)] bg-[var(--bg-elevated)] p-5 xl:block">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">Canvas overview</p>
          <h3 className="mt-2 text-sm font-bold text-[var(--text-primary)]">{activeMode === 'image' ? '生图 / 关键帧关系' : '生视频输入链路'}</h3>
          <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-tertiary)]">
            画布只展示参考资产、镜头、提示词和结果之间的关系。生成动作仍在原有阶段内完成，并保留原有人工确认与模型配置边界。
          </p>

          <div className="mt-5 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-surface)] p-3">
              <p className="text-[9px] text-[var(--text-muted)]">节点</p>
              <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">{graph.nodes.length}</p>
            </div>
            <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-surface)] p-3">
              <p className="text-[9px] text-[var(--text-muted)]">结果</p>
              <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">{generatedCount}/{outputCount}</p>
            </div>
          </div>

          <div className="mt-5 space-y-2 border-t border-[var(--border-primary)] pt-4">
            {[
              ['reference', '参考资产'],
              ['shot', '镜头输入'],
              ['image', '图像结果'],
              ['video', '视频结果'],
            ].map(([kind, label]) => (
              <div key={kind} className="flex items-center justify-between text-[10px] text-[var(--text-tertiary)]">
                <span className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${kind === 'reference' ? 'bg-amber-300' : kind === 'shot' ? 'bg-slate-300' : kind === 'image' ? 'bg-violet-300' : 'bg-emerald-300'}`} />{label}</span>
                <span className="font-mono">{graph.nodes.filter((node) => node.kind === kind).length}</span>
              </div>
            ))}
          </div>

          {selectedNode && (
            <div className="mt-5 rounded-lg border border-[var(--accent-border)] bg-[var(--accent-bg)] p-3">
              <p className="text-[9px] font-bold uppercase tracking-wider text-[var(--accent-text)]">当前节点</p>
              <p className="mt-1 text-xs font-bold text-[var(--text-primary)]">{selectedNode.title}</p>
              <p className="mt-1 line-clamp-4 text-[10px] leading-relaxed text-[var(--text-secondary)]">{selectedNode.subtitle}</p>
              {selectedNode.shotId && onOpenShot && (
                <button type="button" onClick={() => onOpenShot(selectedNode.shotId!)} className="mt-3 text-[10px] font-bold text-[var(--accent-text)] hover:underline">
                  返回镜头工作台 →
                </button>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};

export default InfiniteCanvas;
