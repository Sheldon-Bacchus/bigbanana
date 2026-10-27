import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import {
  CanvasEdgeEntity,
  CanvasGraphEntity,
  CanvasNodeEntity,
  MediaCanvasState,
  MediaCanvasViewport,
  ProjectState,
} from '../types';
import { getCanvasGraph, saveCanvasGraph } from '../services/storageService';
import {
  CanvasEntryMode,
  CanvasMode,
  ConnectingState,
  DEFAULT_VIEWPORT,
  DragState,
  NODE_HEIGHT,
  NODE_WIDTH,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  clamp,
} from './canvas/canvasConstants';
import {
  buildInitialCanvasGraph,
  calculateHandlePosition,
  generateStableId,
  mergeGraphWithProject,
  validateNewEdge,
} from './canvas/canvasGraphUtils';
import { CanvasNodeCard } from './canvas/CanvasNodeCard';
import { CanvasEdgeLayer } from './canvas/CanvasEdgeLayer';
import { CanvasToolbar } from './canvas/CanvasToolbar';

interface InfiniteCanvasProps {
  project: ProjectState;
  initialMode?: CanvasEntryMode;
  onClose: () => void;
  onOpenShot?: (shotId: string) => void;
  onChange: (mode: CanvasMode, state: MediaCanvasState) => void;
}

const InfiniteCanvas: React.FC<InfiniteCanvasProps> = ({
  project,
  initialMode = 'all',
  onClose,
  onOpenShot,
  onChange,
}) => {
  // 1. 画布主模态与数据实体（以 CanvasGraphEntity 为单一真源）
  const [activeMode, setActiveMode] = useState<CanvasMode>(
    initialMode === 'video' ? 'video' : 'image'
  );
  const [graph, setGraph] = useState<CanvasGraphEntity | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('saved');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const [connectingState, setConnectingState] = useState<ConnectingState | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDirtyRef = useRef<boolean>(false);
  const latestGraphRef = useRef<CanvasGraphEntity | null>(null);

  // 临时提示消息自动淡出
  const showNotification = useCallback((message: string) => {
    setNotification(message);
    setTimeout(() => {
      setNotification((current) => (current === message ? null : current));
    }, 3000);
  }, []);

  // 2. 存盘逻辑与 Flush 保证
  const performSave = useCallback(async () => {
    if (!isDirtyRef.current || !latestGraphRef.current) return;
    try {
      setSaveStatus('saving');
      const toSave: CanvasGraphEntity = {
        ...latestGraphRef.current,
        updatedAt: Date.now(),
      };
      await saveCanvasGraph(toSave);
      isDirtyRef.current = false;
      setSaveStatus('saved');
    } catch (err) {
      console.warn('saveCanvasGraph failed:', err);
      // 失败时保留本地状态
      setSaveStatus('error');
    }
  }, []);

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await performSave();
  }, [performSave]);

  // 3. 图状态变更封装（自动触发防抖 600ms 存盘与旧字段兼容回调）
  const updateGraph = useCallback(
    (updater: (prev: CanvasGraphEntity) => CanvasGraphEntity) => {
      setGraph((prev) => {
        if (!prev) return prev;
        const next = updater(prev);
        latestGraphRef.current = next;
        isDirtyRef.current = true;

        // 回传 App 兼容旧字段（标记模式为 interactive）
        onChange(activeMode, {
          version: 2,
          mode: 'interactive',
          viewport: next.viewport,
          nodePositions: next.legacyNodePositions || {},
          updatedAt: Date.now(),
        });

        // 防抖 600ms 存盘
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
        }
        setSaveStatus('saving');
        saveTimerRef.current = setTimeout(() => {
          performSave();
        }, 600);

        return next;
      });
    },
    [activeMode, onChange, performSave]
  );

  // 4. 数据加载与生命周期：进入或切换模式/分集时拉取并初始化图
  useEffect(() => {
    let isCancelled = false;

    const loadGraph = async () => {
      try {
        const stored = await getCanvasGraph(project.id, activeMode);
        if (isCancelled) return;

        if (stored) {
          const merged = mergeGraphWithProject(stored, project, activeMode);
          setGraph(merged);
          latestGraphRef.current = merged;
          isDirtyRef.current = false;
          setSaveStatus('saved');
        } else {
          // 无历史记录，使用推导初始图构建
          const legacyState = activeMode === 'image' ? project.imageCanvas : project.videoCanvas;
          const initial = buildInitialCanvasGraph(project, activeMode, legacyState);
          setGraph(initial);
          latestGraphRef.current = initial;
          isDirtyRef.current = true;
          // 初次构建直接存盘
          saveCanvasGraph(initial).catch((err) => {
            console.warn('Initial saveCanvasGraph failed:', err);
          });
          setSaveStatus('saved');
        }
      } catch (err) {
        console.warn('Failed to load canvas graph from IndexedDB:', err);
        const legacyState = activeMode === 'image' ? project.imageCanvas : project.videoCanvas;
        const fallback = buildInitialCanvasGraph(project, activeMode, legacyState);
        if (!isCancelled) {
          setGraph(fallback);
          latestGraphRef.current = fallback;
        }
      }
    };

    loadGraph();

    return () => {
      isCancelled = true;
      flushSave();
    };
  }, [project.id, activeMode, flushSave]);

  // 切换画布模式前先强刷存盘
  const handleModeChange = async (nextMode: CanvasMode) => {
    if (nextMode === activeMode) return;
    await flushSave();
    setActiveMode(nextMode);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  };

  // 关闭前先强刷存盘
  const handleClose = async () => {
    await flushSave();
    onClose();
  };

  // 视口操作
  const updateViewport = (next: MediaCanvasViewport) => {
    updateGraph((prev) => ({
      ...prev,
      viewport: {
        x: next.x,
        y: next.y,
        zoom: clamp(next.zoom, 0.35, 1.6),
      },
    }));
  };

  // 获取当前可见视口中心点在世界坐标系中的对应位置
  const getViewportCenter = useCallback(() => {
    const container = containerRef.current;
    const currentViewport = graph?.viewport || DEFAULT_VIEWPORT;
    const width = container?.clientWidth || 1000;
    const height = container?.clientHeight || 700;
    return {
      x: (width / 2 - currentViewport.x) / currentViewport.zoom,
      y: (height / 2 - currentViewport.y) / currentViewport.zoom,
    };
  }, [graph?.viewport]);

  // 工具栏功能：+ 配置节点
  const handleAddConfigNode = () => {
    if (!graph) return;
    const center = getViewportCenter();
    const nodeId = generateStableId('cnode-cfg');
    const newNode: CanvasNodeEntity = {
      id: nodeId,
      graphId: graph.id,
      type: 'config_node',
      position: {
        x: Math.max(20, Math.round(center.x - NODE_WIDTH / 2)),
        y: Math.max(20, Math.round(center.y - NODE_HEIGHT / 2)),
      },
      data: {
        title: '配置节点',
        subtitle: '提示词 / 风格参数',
        prompt: '',
        status: '就绪',
      },
    };
    updateGraph((prev) => ({
      ...prev,
      nodes: [...prev.nodes, newNode],
      legacyNodePositions: {
        ...(prev.legacyNodePositions || {}),
        [nodeId]: newNode.position,
      },
    }));
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
  };

  // 工具栏功能：+ 参考槽位
  const handleAddReferenceSlot = () => {
    if (!graph) return;
    const center = getViewportCenter();
    const existingSlots = graph.nodes.filter((n) => n.type === 'reference_slot');
    const slotNumber = existingSlots.length + 1;
    const nodeId = generateStableId('cnode-ref');
    const newNode: CanvasNodeEntity = {
      id: nodeId,
      graphId: graph.id,
      type: 'reference_slot',
      position: {
        x: Math.max(20, Math.round(center.x - NODE_WIDTH / 2)),
        y: Math.max(20, Math.round(center.y - NODE_HEIGHT / 2)),
      },
      data: {
        title: `参考槽位 #${slotNumber}`,
        subtitle: '单资产参考图',
        slotNumber,
        imageUrl: '',
        status: '待绑定',
      },
    };
    updateGraph((prev) => ({
      ...prev,
      nodes: [...prev.nodes, newNode],
      legacyNodePositions: {
        ...(prev.legacyNodePositions || {}),
        [nodeId]: newNode.position,
      },
    }));
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
  };

  // 删除选中项（支持选中节点或连线）
  const handleDeleteSelected = useCallback(() => {
    if (selectedEdgeId) {
      updateGraph((prev) => ({
        ...prev,
        edges: prev.edges.filter((e) => e.id !== selectedEdgeId),
      }));
      setSelectedEdgeId(null);
      return;
    }
    if (selectedNodeId) {
      updateGraph((prev) => {
        const remainingNodes = prev.nodes.filter((n) => n.id !== selectedNodeId);
        const remainingEdges = prev.edges.filter(
          (e) => e.sourceNodeId !== selectedNodeId && e.targetNodeId !== selectedNodeId
        );
        const remainingPositions = { ...(prev.legacyNodePositions || {}) };
        delete remainingPositions[selectedNodeId];
        return {
          ...prev,
          nodes: remainingNodes,
          edges: remainingEdges,
          legacyNodePositions: remainingPositions,
        };
      });
      setSelectedNodeId(null);
    }
  }, [selectedEdgeId, selectedNodeId, updateGraph]);

  // 全局键盘监听：Delete / Backspace 键删除选中节点或连线
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const target = event.target as HTMLElement;
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) {
          return;
        }
        if (selectedNodeId || selectedEdgeId) {
          event.preventDefault();
          handleDeleteSelected();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNodeId, selectedEdgeId, handleDeleteSelected]);

  // 画布平移交互
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      target.closest('[data-canvas-node="true"]') ||
      target.closest('[data-handle-id]') ||
      target.closest('button')
    ) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    dragRef.current = {
      type: 'canvas',
      startX: event.clientX,
      startY: event.clientY,
      startViewport: graph?.viewport || DEFAULT_VIEWPORT,
    };
  };

  // 节点拖拽交互
  const handleNodePointerDown = (
    node: CanvasNodeEntity,
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    dragRef.current = {
      type: 'node',
      nodeId: node.id,
      startX: event.clientX,
      startY: event.clientY,
      startNode: { x: node.position.x, y: node.position.y },
    };
  };

  // 插槽连线交互启动
  const handleStartConnecting = (
    nodeId: string,
    handleId: string,
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    event.stopPropagation();
    if (!graph || !containerRef.current) return;
    const sourceNode = graph.nodes.find((n) => n.id === nodeId);
    if (!sourceNode) return;

    const handlePos = calculateHandlePosition(sourceNode, handleId, 'output');
    setConnectingState({
      sourceNodeId: nodeId,
      sourceHandle: handleId,
      startX: handlePos.x,
      startY: handlePos.y,
      currentX: handlePos.x,
      currentY: handlePos.y,
    });
  };

  // 全局移动响应（平移 / 拖动节点 / 连线实时更新）
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const currentViewport = graph?.viewport || DEFAULT_VIEWPORT;

    // 1. 若正在连线，实时计算鼠标在画布坐标系中的端点
    if (connectingState && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const worldX = (event.clientX - rect.left - currentViewport.x) / currentViewport.zoom;
      const worldY = (event.clientY - rect.top - currentViewport.y) / currentViewport.zoom;
      setConnectingState((prev) => (prev ? { ...prev, currentX: worldX, currentY: worldY } : null));
      return;
    }

    const drag = dragRef.current;
    if (!drag) return;

    // 2. 画布平移
    if (drag.type === 'canvas' && drag.startViewport) {
      updateViewport({
        ...drag.startViewport,
        x: drag.startViewport.x + event.clientX - drag.startX,
        y: drag.startViewport.y + event.clientY - drag.startY,
      });
      return;
    }

    // 3. 节点拖拽移动（连线会根据节点坐标实时联动刷新）
    if (drag.type === 'node' && drag.nodeId && drag.startNode) {
      const nextX = Math.max(8, drag.startNode.x + (event.clientX - drag.startX) / currentViewport.zoom);
      const nextY = Math.max(8, drag.startNode.y + (event.clientY - drag.startY) / currentViewport.zoom);

      updateGraph((prev) => ({
        ...prev,
        nodes: prev.nodes.map((node) =>
          node.id === drag.nodeId
            ? { ...node, position: { x: nextX, y: nextY } }
            : node
        ),
        legacyNodePositions: {
          ...(prev.legacyNodePositions || {}),
          [drag.nodeId!]: { x: nextX, y: nextY },
        },
      }));
    }
  };

  // 释放鼠标事件
  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;

    // 处理连线落点判定
    if (connectingState && graph) {
      const elem = document.elementFromPoint(event.clientX, event.clientY);
      const handleElem = elem?.closest('[data-handle-type="input"]');
      if (handleElem) {
        const targetNodeId = handleElem.getAttribute('data-node-id');
        const targetHandle = handleElem.getAttribute('data-handle-id');

        if (targetNodeId && targetHandle) {
          const validation = validateNewEdge(
            graph.nodes,
            graph.edges,
            connectingState.sourceNodeId,
            connectingState.sourceHandle,
            targetNodeId,
            targetHandle
          );

          if (validation.valid) {
            const newEdge: CanvasEdgeEntity = {
              id: generateStableId('edge'),
              sourceNodeId: connectingState.sourceNodeId,
              sourceHandle: connectingState.sourceHandle,
              targetNodeId,
              targetHandle,
            };
            updateGraph((prev) => ({
              ...prev,
              edges: [...prev.edges, newEdge],
            }));
            setSelectedEdgeId(newEdge.id);
            setSelectedNodeId(null);
          } else if (validation.error) {
            showNotification(validation.error);
          }
        }
      }
      setConnectingState(null);
    }
  };

  // 滚轮缩放
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const currentViewport = graph?.viewport || DEFAULT_VIEWPORT;
    const direction = event.deltaY > 0 ? -0.05 : 0.05;
    updateViewport({ ...currentViewport, zoom: currentViewport.zoom + direction });
  };

  const nodeMap = useMemo(
    () => new Map((graph?.nodes || []).map((node) => [node.id, node])),
    [graph?.nodes]
  );
  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) : undefined;
  const viewport = graph?.viewport || DEFAULT_VIEWPORT;

  const generatedCount = (graph?.nodes || []).filter(
    (node) => node.data?.status === '已生成' || node.data?.status === 'succeeded'
  ).length;
  const outputCount = (graph?.nodes || []).filter(
    (node) => node.type === 'artifact_output'
  ).length;

  return (
    <div className="absolute inset-0 z-[60] flex min-w-0 flex-col bg-[var(--bg-secondary)] text-[var(--text-secondary)] select-none">
      {/* 顶部工具栏 */}
      <CanvasToolbar
        activeMode={activeMode}
        viewport={viewport}
        saveStatus={saveStatus}
        hasSelection={Boolean(selectedNodeId || selectedEdgeId)}
        onModeChange={handleModeChange}
        onAddConfigNode={handleAddConfigNode}
        onAddReferenceSlot={handleAddReferenceSlot}
        onDeleteSelected={handleDeleteSelected}
        onZoomIn={() => updateViewport({ ...viewport, zoom: viewport.zoom + 0.1 })}
        onZoomOut={() => updateViewport({ ...viewport, zoom: viewport.zoom - 0.1 })}
        onResetViewport={() => {
          updateViewport(DEFAULT_VIEWPORT);
          setSelectedNodeId(null);
          setSelectedEdgeId(null);
        }}
        onClose={handleClose}
      />

      {/* 浮动警告 / 校验提示横幅 */}
      {notification && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)]/95 px-4 py-2 text-xs font-medium text-[var(--warning-text)] shadow-xl backdrop-blur animate-in fade-in slide-in-from-top-2 duration-200">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />
          <span>{notification}</span>
        </div>
      )}

      {/* 画布主工作区 */}
      <div className="flex min-h-0 flex-1 relative overflow-hidden">
        <div
          ref={containerRef}
          className="relative min-w-0 flex-1 cursor-grab overflow-hidden bg-[var(--bg-base)] active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        >
          {/* 网格点阵背景 */}
          <div
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{
              backgroundImage:
                'radial-gradient(circle, var(--border-primary) 1px, transparent 1px)',
              backgroundSize: '22px 22px',
            }}
          />

          {/* 交互提示 */}
          <div className="absolute left-4 top-4 z-10 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-surface)]/90 px-3 py-2 text-[10px] text-[var(--text-muted)] shadow-lg backdrop-blur">
            拖拽空白处平移 · 拖拽节点整理位置 · 拖拽右侧圆点连线 · Delete 键删除
          </div>

          {/* 画布视口缩放容器 */}
          <div
            className="absolute left-0 top-0"
            style={{
              width: WORLD_WIDTH,
              height: WORLD_HEIGHT,
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
              transformOrigin: 'top left',
            }}
          >
            {/* SVG 连线层 (渲染在节点下方) */}
            <CanvasEdgeLayer
              edges={graph?.edges || []}
              nodeMap={nodeMap}
              selectedEdgeId={selectedEdgeId}
              connectingState={connectingState}
              onSelectEdge={(edgeId) => {
                setSelectedEdgeId(edgeId);
                setSelectedNodeId(null);
              }}
              onDeleteEdge={(edgeId) => {
                updateGraph((prev) => ({
                  ...prev,
                  edges: prev.edges.filter((e) => e.id !== edgeId),
                }));
                setSelectedEdgeId(null);
              }}
            />

            {/* 节点层 */}
            {(graph?.nodes || []).map((node) => (
              <CanvasNodeCard
                key={node.id}
                node={node}
                selected={selectedNodeId === node.id}
                onSelect={() => {
                  setSelectedNodeId(node.id);
                  setSelectedEdgeId(null);
                }}
                onDelete={() => {
                  updateGraph((prev) => {
                    const remainingNodes = prev.nodes.filter((n) => n.id !== node.id);
                    const remainingEdges = prev.edges.filter(
                      (e) => e.sourceNodeId !== node.id && e.targetNodeId !== node.id
                    );
                    const remainingPositions = { ...(prev.legacyNodePositions || {}) };
                    delete remainingPositions[node.id];
                    return {
                      ...prev,
                      nodes: remainingNodes,
                      edges: remainingEdges,
                      legacyNodePositions: remainingPositions,
                    };
                  });
                  if (selectedNodeId === node.id) setSelectedNodeId(null);
                }}
                onOpenShot={onOpenShot}
                onUpdateData={(patch) => {
                  updateGraph((prev) => ({
                    ...prev,
                    nodes: prev.nodes.map((n) =>
                      n.id === node.id ? { ...n, data: { ...n.data, ...patch } } : n
                    ),
                  }));
                }}
                onPointerDown={(event) => handleNodePointerDown(node, event)}
                onStartConnecting={handleStartConnecting}
              />
            ))}
          </div>
        </div>

        {/* 右侧属性与概览抽屉 */}
        <aside className="hidden w-64 shrink-0 border-l border-[var(--border-primary)] bg-[var(--bg-elevated)] p-5 xl:block overflow-y-auto">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
            CANVAS OVERVIEW
          </p>
          <h3 className="mt-2 text-sm font-bold text-[var(--text-primary)]">
            {activeMode === 'image' ? '生图 / 关键帧链路' : '生视频输入与分镜链路'}
          </h3>
          <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-tertiary)]">
            在此自由编排镜头、参考资产、自定义提示词配置与产物槽位。画布具备持久化拓扑与插槽强类型约束。
          </p>

          <div className="mt-5 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-surface)] p-3">
              <p className="text-[9px] text-[var(--text-muted)]">总节点数</p>
              <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">
                {graph?.nodes.length || 0}
              </p>
            </div>
            <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-surface)] p-3">
              <p className="text-[9px] text-[var(--text-muted)]">连线数</p>
              <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">
                {graph?.edges.length || 0}
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-2 border-t border-[var(--border-primary)] pt-4">
            <p className="text-[9px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-2">
              节点分类分布
            </p>
            {[
              ['shot_projection', '镜头投影', 'bg-slate-400'],
              ['config_node', '配置节点', 'bg-sky-400'],
              ['reference_slot', '参考槽位', 'bg-amber-400'],
              ['generation_task', '执行任务', 'bg-blue-400'],
              ['artifact_output', '媒体产物', 'bg-violet-400'],
            ].map(([type, label, dotColor]) => (
              <div
                key={type}
                className="flex items-center justify-between text-[10px] text-[var(--text-tertiary)]"
              >
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${dotColor}`} />
                  {label}
                </span>
                <span className="font-mono">
                  {(graph?.nodes || []).filter((node) => node.type === type).length}
                </span>
              </div>
            ))}
          </div>

          {/* 选中节点详情面板 */}
          {selectedNode && (
            <div className="mt-5 rounded-lg border border-[var(--accent-border)] bg-[var(--accent-bg)] p-3 space-y-2">
              <p className="text-[9px] font-bold uppercase tracking-wider text-[var(--accent-text)]">
                当前选中节点
              </p>
              <p className="text-xs font-bold text-[var(--text-primary)] truncate">
                {String(selectedNode.data?.title || selectedNode.id)}
              </p>
              <p className="text-[9px] font-mono text-[var(--text-muted)]">
                类型: {selectedNode.type}
              </p>
              {selectedNode.data?.prompt !== undefined && (
                <div className="text-[10px] leading-relaxed text-[var(--text-secondary)] line-clamp-3 bg-[var(--bg-base)]/50 p-2 rounded">
                  {String(selectedNode.data.prompt || '暂无提示词')}
                </div>
              )}
              {selectedNode.data?.shotId && onOpenShot && (
                <button
                  type="button"
                  onClick={() => onOpenShot(String(selectedNode.data.shotId))}
                  className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold text-[var(--accent-text)] hover:underline"
                >
                  前往对应镜头工作台 →
                </button>
              )}
            </div>
          )}

          {/* 选中连线详情面板 */}
          {selectedEdgeId && (
            <div className="mt-5 rounded-lg border border-[var(--accent-border)] bg-[var(--accent-bg)] p-3 space-y-2">
              <p className="text-[9px] font-bold uppercase tracking-wider text-[var(--accent-text)]">
                当前选中连线
              </p>
              <p className="text-[9px] font-mono text-[var(--text-muted)] truncate">
                ID: {selectedEdgeId}
              </p>
              <button
                type="button"
                onClick={handleDeleteSelected}
                className="w-full mt-2 rounded border border-[var(--error-border)] bg-[var(--error-hover-bg)] py-1 text-[10px] font-medium text-[var(--error-text)] hover:opacity-90"
              >
                删除此连线
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};

export default InfiniteCanvas;
