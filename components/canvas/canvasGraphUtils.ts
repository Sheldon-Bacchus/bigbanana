import {
  CanvasEdgeEntity,
  CanvasGraphEntity,
  CanvasNodeEntity,
  MediaCanvasState,
  ProjectState,
  Shot,
} from '../../types';
import {
  ARTIFACT_NODE_HEIGHT,
  CanvasMode,
  CONFIG_NODE_HEIGHT,
  DEFAULT_VIEWPORT,
  NODE_HEIGHT,
  NODE_WIDTH,
  REFERENCE_BUNDLE_HEIGHT,
  TASK_NODE_HEIGHT,
} from './canvasConstants';

export const generateStableId = (prefix: string): string => {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
};

export const getStartFrame = (shot: Shot) =>
  shot.keyframes?.find((keyframe) => keyframe.type === 'start');

export const getImageStatus = (shot: Shot): string => {
  const frame = getStartFrame(shot);
  if (frame?.imageUrl) return '已生成';
  if (frame?.status === 'generating') return '生成中';
  if (frame?.status === 'failed') return '生成失败';
  return '待生成';
};

export const getVideoStatus = (shot: Shot): string => {
  if (shot.interval?.videoUrl) return '已生成';
  if (shot.interval?.status === 'generating') return '生成中';
  if (shot.interval?.status === 'failed') return '生成失败';
  return '待生成';
};

export const getReferenceImage = (project: ProjectState): string | undefined => {
  const candidates = [
    ...(project.scriptData?.characters || []).map((character) => character.referenceImage),
    ...(project.scriptData?.scenes || []).map((scene) => scene.referenceImage),
    ...(project.scriptData?.props || []).map((prop) => prop.referenceImage),
  ];
  return candidates.find((image): image is string => Boolean(image));
};

export const resolvePosition = (
  legacyPositions: Record<string, { x: number; y: number }> | undefined,
  id: string,
  fallback: { x: number; y: number }
): { x: number; y: number } => {
  if (legacyPositions && legacyPositions[id]) {
    return { ...legacyPositions[id] };
  }
  return fallback;
};

export const getNodeDimensions = (node: CanvasNodeEntity): { width: number; height: number } => {
  if (node.size) return node.size;
  switch (node.type) {
    case 'reference_slot':
      return {
        width: NODE_WIDTH,
        height: node.data?.isBundle ? REFERENCE_BUNDLE_HEIGHT : NODE_HEIGHT,
      };
    case 'config_node':
      return { width: NODE_WIDTH, height: CONFIG_NODE_HEIGHT };
    case 'generation_task':
      return { width: NODE_WIDTH, height: TASK_NODE_HEIGHT };
    case 'artifact_output':
      return { width: NODE_WIDTH, height: ARTIFACT_NODE_HEIGHT };
    case 'shot_projection':
    default:
      return { width: NODE_WIDTH, height: NODE_HEIGHT };
  }
};

/**
 * 计算插槽连接点的绝对画布坐标
 */
export const calculateHandlePosition = (
  node: CanvasNodeEntity,
  handleId: string,
  handleType: 'input' | 'output'
): { x: number; y: number } => {
  const { width, height } = getNodeDimensions(node);
  const x = handleType === 'output' ? node.position.x + width : node.position.x;

  // 垂直位置依据 handle 种类居中或等分
  let y = node.position.y + height / 2;
  if (handleId === 'slot-1') {
    y = node.position.y + 70;
  } else if (handleId === 'slot-2' || handleId === 'slot-config') {
    y = node.position.y + 115;
  } else if (handleId === 'output-image') {
    y = node.position.y + 70;
  } else if (handleId === 'output-video') {
    y = node.position.y + 115;
  }

  return { x, y };
};

/**
 * 基于 Project 推导初始化的 CanvasGraphEntity
 */
export const buildInitialCanvasGraph = (
  project: ProjectState,
  mode: CanvasMode,
  legacyState?: MediaCanvasState
): CanvasGraphEntity => {
  const graphId = `cgraph-${project.id}-${mode}`;
  const legacyPositions = legacyState?.nodePositions || {};
  const viewport = legacyState?.viewport || DEFAULT_VIEWPORT;

  const nodes: CanvasNodeEntity[] = [];
  const edges: CanvasEdgeEntity[] = [];
  const shots = project.shots || [];

  const referenceCount =
    (project.scriptData?.characters?.length || 0) +
    (project.scriptData?.scenes?.length || 0) +
    (project.scriptData?.props?.length || 0);

  const referenceId = `reference-bundle-${mode}`;
  const referencePos = resolvePosition(legacyPositions, referenceId, { x: 40, y: 50 });
  nodes.push({
    id: referenceId,
    graphId,
    type: 'reference_slot',
    position: referencePos,
    size: { width: NODE_WIDTH, height: REFERENCE_BUNDLE_HEIGHT },
    data: {
      title: mode === 'image' ? '图像参考资产' : '视频输入参考',
      subtitle: `${referenceCount} 项角色 / 场景 / 道具绑定`,
      status: '只读上下文',
      imageUrl: getReferenceImage(project),
      isBundle: true,
      slotNumber: 0,
    },
  });

  shots.forEach((shot, index) => {
    const row = index % 3;
    const columnOffset = Math.floor(index / 3) * 40;
    const y = 50 + row * 260;
    const shotId = `shot-${shot.id}`;
    const imageId = `image-${shot.id}`;
    const videoId = `video-${shot.id}`;
    const startFrame = getStartFrame(shot);

    const shotPosition = resolvePosition(legacyPositions, shotId, { x: 340 + columnOffset, y });
    nodes.push({
      id: shotId,
      graphId,
      type: 'shot_projection',
      position: shotPosition,
      size: { width: NODE_WIDTH, height: NODE_HEIGHT },
      sourceRef: {
        episodeId: project.id,
        shotId: shot.id,
      },
      data: {
        shotId: shot.id,
        title: `SHOT ${String(index + 1).padStart(3, '0')}`,
        subtitle: shot.cameraMovement || '未设置运镜',
        status: shot.actionSummary ? '镜头提示词已绑定' : '缺少动作描述',
        actionSummary: shot.actionSummary,
        shotSize: shot.shotSize,
        cameraMovement: shot.cameraMovement,
      },
    });

    // 默认连线：参考资产 -> 分镜投影
    edges.push({
      id: `edge-${referenceId}-output-image-${shotId}-slot-1`,
      sourceNodeId: referenceId,
      sourceHandle: 'output-image',
      targetNodeId: shotId,
      targetHandle: 'slot-1',
    });

    // 生图产物卡片
    const imagePosition = resolvePosition(legacyPositions, imageId, { x: 640 + columnOffset, y });
    nodes.push({
      id: imageId,
      graphId,
      type: 'artifact_output',
      position: imagePosition,
      size: { width: NODE_WIDTH, height: ARTIFACT_NODE_HEIGHT },
      sourceRef: {
        episodeId: project.id,
        shotId: shot.id,
      },
      data: {
        shotId: shot.id,
        title: '生图 / 关键帧',
        subtitle: startFrame?.visualPrompt || '提示词会从镜头动作与资产上下文生成',
        status: getImageStatus(shot),
        imageUrl: startFrame?.imageUrl,
        mediaType: 'image',
      },
    });

    // 默认连线：分镜投影 -> 生图产物
    edges.push({
      id: `edge-${shotId}-output-image-${imageId}-slot-1`,
      sourceNodeId: shotId,
      sourceHandle: 'output-image',
      targetNodeId: imageId,
      targetHandle: 'slot-1',
    });

    // 视频模式下新增生视频产物卡片
    if (mode === 'video') {
      const videoPosition = resolvePosition(legacyPositions, videoId, { x: 940 + columnOffset, y });
      nodes.push({
        id: videoId,
        graphId,
        type: 'artifact_output',
        position: videoPosition,
        size: { width: NODE_WIDTH, height: ARTIFACT_NODE_HEIGHT },
        sourceRef: {
          episodeId: project.id,
          shotId: shot.id,
        },
        data: {
          shotId: shot.id,
          title: '生视频',
          subtitle: shot.interval?.videoPrompt || '视频运动提示词待确认',
          status: getVideoStatus(shot),
          videoUrl: shot.interval?.videoUrl,
          mediaType: 'video',
        },
      });

      // 默认连线：分镜投影 -> 视频产物
      edges.push({
        id: `edge-${shotId}-output-video-${videoId}-slot-1`,
        sourceNodeId: shotId,
        sourceHandle: 'output-video',
        targetNodeId: videoId,
        targetHandle: 'slot-1',
      });
    }
  });

  const legacyNodePositions: Record<string, { x: number; y: number }> = { ...legacyPositions };
  nodes.forEach((node) => {
    legacyNodePositions[node.id] = { ...node.position };
  });

  return {
    id: graphId,
    episodeId: project.id,
    mode,
    viewport,
    nodes,
    edges,
    legacyNodePositions,
    updatedAt: Date.now(),
  };
};

/**
 * 合并已存储的图数据与分镜工作台最新状态（增量同步）
 */
export const mergeGraphWithProject = (
  savedGraph: CanvasGraphEntity,
  project: ProjectState,
  mode: CanvasMode
): CanvasGraphEntity => {
  const existingNodeMap = new Map<string, CanvasNodeEntity>(
    savedGraph.nodes.map((node) => [node.id, node])
  );
  const updatedNodes: CanvasNodeEntity[] = [];
  const updatedEdges: CanvasEdgeEntity[] = [...savedGraph.edges];
  const legacyNodePositions: Record<string, { x: number; y: number }> = {
    ...(savedGraph.legacyNodePositions || {}),
  };

  const shots = project.shots || [];
  const referenceCount =
    (project.scriptData?.characters?.length || 0) +
    (project.scriptData?.scenes?.length || 0) +
    (project.scriptData?.props?.length || 0);

  // 1. 同步全局参考资产包
  const referenceId = `reference-bundle-${mode}`;
  const existingRefNode = existingNodeMap.get(referenceId);
  const refPos = existingRefNode?.position ||
    savedGraph.legacyNodePositions?.[referenceId] || { x: 40, y: 50 };
  const refNode: CanvasNodeEntity = {
    id: referenceId,
    graphId: savedGraph.id,
    type: 'reference_slot',
    position: refPos,
    size: { width: NODE_WIDTH, height: REFERENCE_BUNDLE_HEIGHT },
    data: {
      ...(existingRefNode?.data || {}),
      title: mode === 'image' ? '图像参考资产' : '视频输入参考',
      subtitle: `${referenceCount} 项角色 / 场景 / 道具绑定`,
      status: '只读上下文',
      imageUrl: getReferenceImage(project),
      isBundle: true,
      slotNumber: 0,
    },
  };
  updatedNodes.push(refNode);
  existingNodeMap.delete(referenceId);
  legacyNodePositions[referenceId] = refPos;

  // 2. 同步分镜派生节点
  shots.forEach((shot, index) => {
    const row = index % 3;
    const columnOffset = Math.floor(index / 3) * 40;
    const y = 50 + row * 260;
    const shotId = `shot-${shot.id}`;
    const imageId = `image-${shot.id}`;
    const videoId = `video-${shot.id}`;
    const startFrame = getStartFrame(shot);

    // Shot 节点
    const existingShot = existingNodeMap.get(shotId);
    const shotPos = existingShot?.position ||
      savedGraph.legacyNodePositions?.[shotId] || { x: 340 + columnOffset, y };
    updatedNodes.push({
      id: shotId,
      graphId: savedGraph.id,
      type: 'shot_projection',
      position: shotPos,
      size: { width: NODE_WIDTH, height: NODE_HEIGHT },
      sourceRef: {
        episodeId: project.id,
        shotId: shot.id,
      },
      data: {
        ...(existingShot?.data || {}),
        shotId: shot.id,
        title: `SHOT ${String(index + 1).padStart(3, '0')}`,
        subtitle: shot.cameraMovement || '未设置运镜',
        status: shot.actionSummary ? '镜头提示词已绑定' : '缺少动作描述',
        actionSummary: shot.actionSummary,
        shotSize: shot.shotSize,
        cameraMovement: shot.cameraMovement,
      },
    });
    existingNodeMap.delete(shotId);
    legacyNodePositions[shotId] = shotPos;

    // 生图产物卡片
    const existingImage = existingNodeMap.get(imageId);
    const imagePos = existingImage?.position ||
      savedGraph.legacyNodePositions?.[imageId] || { x: 640 + columnOffset, y };
    updatedNodes.push({
      id: imageId,
      graphId: savedGraph.id,
      type: 'artifact_output',
      position: imagePos,
      size: { width: NODE_WIDTH, height: ARTIFACT_NODE_HEIGHT },
      sourceRef: {
        episodeId: project.id,
        shotId: shot.id,
      },
      data: {
        ...(existingImage?.data || {}),
        shotId: shot.id,
        title: '生图 / 关键帧',
        subtitle: startFrame?.visualPrompt || '提示词会从镜头动作与资产上下文生成',
        status: getImageStatus(shot),
        imageUrl: startFrame?.imageUrl,
        mediaType: 'image',
      },
    });
    existingNodeMap.delete(imageId);
    legacyNodePositions[imageId] = imagePos;

    // 默认连线确保存在
    const refEdgeKey = `${referenceId}-${shotId}`;
    if (!updatedEdges.some((e) => e.sourceNodeId === referenceId && e.targetNodeId === shotId)) {
      updatedEdges.push({
        id: `edge-${refEdgeKey}`,
        sourceNodeId: referenceId,
        sourceHandle: 'output-image',
        targetNodeId: shotId,
        targetHandle: 'slot-1',
      });
    }
    if (!updatedEdges.some((e) => e.sourceNodeId === shotId && e.targetNodeId === imageId)) {
      updatedEdges.push({
        id: `edge-${shotId}-${imageId}`,
        sourceNodeId: shotId,
        sourceHandle: 'output-image',
        targetNodeId: imageId,
        targetHandle: 'slot-1',
      });
    }

    if (mode === 'video') {
      const existingVideo = existingNodeMap.get(videoId);
      const videoPos = existingVideo?.position ||
        savedGraph.legacyNodePositions?.[videoId] || { x: 940 + columnOffset, y };
      updatedNodes.push({
        id: videoId,
        graphId: savedGraph.id,
        type: 'artifact_output',
        position: videoPos,
        size: { width: NODE_WIDTH, height: ARTIFACT_NODE_HEIGHT },
        sourceRef: {
          episodeId: project.id,
          shotId: shot.id,
        },
        data: {
          ...(existingVideo?.data || {}),
          shotId: shot.id,
          title: '生视频',
          subtitle: shot.interval?.videoPrompt || '视频运动提示词待确认',
          status: getVideoStatus(shot),
          videoUrl: shot.interval?.videoUrl,
          mediaType: 'video',
        },
      });
      existingNodeMap.delete(videoId);
      legacyNodePositions[videoId] = videoPos;

      if (!updatedEdges.some((e) => e.sourceNodeId === shotId && e.targetNodeId === videoId)) {
        updatedEdges.push({
          id: `edge-${shotId}-${videoId}`,
          sourceNodeId: shotId,
          sourceHandle: 'output-video',
          targetNodeId: videoId,
          targetHandle: 'slot-1',
        });
      }
    }
  });

  // 3. 保留所有用户创建的自定义节点（config_node, reference_slot, generation_task 等）
  for (const remainingNode of existingNodeMap.values()) {
    updatedNodes.push(remainingNode);
    legacyNodePositions[remainingNode.id] = remainingNode.position;
  }

  // 4. 清理脏边（指向已被删除节点的无效边）
  const validNodeIds = new Set(updatedNodes.map((n) => n.id));
  const validEdges = updatedEdges.filter(
    (e) => validNodeIds.has(e.sourceNodeId) && validNodeIds.has(e.targetNodeId)
  );

  return {
    ...savedGraph,
    nodes: updatedNodes,
    edges: validEdges,
    legacyNodePositions,
    updatedAt: Date.now(),
  };
};

/**
 * DFS 环检测：判断若从 sourceNodeId 连到 targetNodeId 是否会造成图中有向环
 * 也就是检查从 targetNodeId 沿着现有有向边出发是否能够到达 sourceNodeId
 */
export const detectCycle = (
  edges: CanvasEdgeEntity[],
  sourceNodeId: string,
  targetNodeId: string
): boolean => {
  if (sourceNodeId === targetNodeId) return true;

  // 构建邻接表
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adj.get(edge.sourceNodeId) || [];
    list.push(edge.targetNodeId);
    adj.set(edge.sourceNodeId, list);
  }

  // 从 targetNodeId 开始 DFS 搜索 sourceNodeId
  const visited = new Set<string>();
  const stack = [targetNodeId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === sourceNodeId) {
      return true; // 存在从 target 到 source 的路径，成环！
    }
    if (!visited.has(current)) {
      visited.add(current);
      const neighbors = adj.get(current) || [];
      for (const next of neighbors) {
        if (!visited.has(next)) {
          stack.push(next);
        }
      }
    }
  }

  return false;
};

/**
 * 校验即将新建的连线是否合法
 */
export const validateNewEdge = (
  nodes: CanvasNodeEntity[],
  edges: CanvasEdgeEntity[],
  sourceNodeId: string,
  sourceHandle: string,
  targetNodeId: string,
  targetHandle: string
): { valid: boolean; error?: string } => {
  // 1. 禁止自环
  if (sourceNodeId === targetNodeId) {
    return { valid: false, error: '禁止连接节点自身（自环）' };
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const sourceNode = nodeMap.get(sourceNodeId);
  const targetNode = nodeMap.get(targetNodeId);

  if (!sourceNode || !targetNode) {
    return { valid: false, error: '端点节点不存在' };
  }

  // 2. 禁止从 artifact_output 连出边
  if (sourceNode.type === 'artifact_output') {
    return { valid: false, error: '生成产物节点为终点，禁止作为输出端连出边' };
  }

  // 3. 禁止向 reference_slot 连入边
  if (targetNode.type === 'reference_slot') {
    return { valid: false, error: '参考资产/槽位为源数据，禁止连入边' };
  }

  // 4. 重复边检查
  const duplicate = edges.some(
    (e) =>
      e.sourceNodeId === sourceNodeId &&
      e.targetNodeId === targetNodeId &&
      e.sourceHandle === sourceHandle &&
      e.targetHandle === targetHandle
  );
  if (duplicate) {
    return { valid: false, error: '两插槽之间已存在相同连线' };
  }

  // 5. DFS 环检测
  if (detectCycle(edges, sourceNodeId, targetNodeId)) {
    return { valid: false, error: '无法建立连线：检测到循环依赖（有向环）' };
  }

  return { valid: true };
};
