import {
  CanvasEdgeEntity,
  CanvasGraphEntity,
  CanvasNodeEntity,
  Episode,
  ProjectState,
  Shot,
} from '../../types';
import { getCanvasGraph, saveCanvasGraph } from '../../services/storageService';
import {
  ARTIFACT_NODE_HEIGHT,
  CanvasMode,
  DEFAULT_VIEWPORT,
  NODE_HEIGHT,
  NODE_WIDTH,
  REFERENCE_BUNDLE_HEIGHT,
} from '../../components/canvas/canvasConstants';
import {
  buildInitialCanvasGraph,
  getImageStatus,
  getStartFrame,
  getVideoStatus,
  mergeGraphWithProject,
} from '../../components/canvas/canvasGraphUtils';

/**
 * 投影配置选项
 */
export interface ProjectEpisodeToCanvasOptions {
  /** 目标聚焦的分镜 ID（如从特定分镜卡触发投影） */
  targetShotId?: string;
  /** 投影作用域：'episode' 整集 | 'shot' 单镜头（默认 'episode'） */
  scope?: 'episode' | 'shot';
  /** 是否保留已有节点坐标（默认 true） */
  preservePositions?: boolean;
}

/**
 * 投影结果
 */
export interface ProjectionResult {
  graph: CanvasGraphEntity;
  createdNodeIds: string[];
  focusedNodeId?: string;
}

/**
 * 32位 FNV-1a 哈希算法实现（基于 upstream-contracts 契约规范）
 * 将输入字符串映射为 32 位无符号整数并转为 base36 编码
 */
export function fnv1a32(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // 32-bit FNV prime 0x01000193 = 16777619
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * 清洗 slug 仅允许 [a-z0-9_-]
 */
export function sanitizeSlug(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

/**
 * 构造符合 contracts/canvas-interop.md 不变量 1 的稳定投影节点 ID
 * 格式：projection_${safeKey}_${digest}__${entityId}
 */
export function buildProjectionNodeId(scopeKey: string, entityId: string): string {
  const fullProjectionKey = `${scopeKey}:${entityId}`;
  const safeKey = sanitizeSlug(scopeKey);
  const digest = fnv1a32(fullProjectionKey);
  const safeEntityId = sanitizeSlug(entityId);
  return `projection_${safeKey}_${digest}__${safeEntityId}`;
}

/**
 * 辅助检查边是否已存在（避免重复连线）
 */
function ensureEdge(
  edges: CanvasEdgeEntity[],
  sourceNodeId: string,
  sourceHandle: string,
  targetNodeId: string,
  targetHandle: string
): void {
  const exists = edges.some(
    (e) =>
      e.sourceNodeId === sourceNodeId &&
      e.targetNodeId === targetNodeId &&
      e.sourceHandle === sourceHandle &&
      e.targetHandle === targetHandle
  );
  if (!exists) {
    edges.push({
      id: `edge-${sourceNodeId}-${sourceHandle}-${targetNodeId}-${targetHandle}`,
      sourceNodeId,
      sourceHandle,
      targetNodeId,
      targetHandle,
    });
  }
}

/**
 * 单模式分集投影执行函数（'image' 或 'video'）
 */
async function projectEpisodeToCanvasForMode(
  episode: Episode,
  targetMode: CanvasMode,
  opts?: ProjectEpisodeToCanvasOptions
): Promise<ProjectionResult> {
  const scopeKey = `ep_${episode.id}`;
  const createdNodeIds: string[] = [];

  // 1. 读取现有画布图（先 getCanvasGraph，无则新建）
  let baseGraph = await getCanvasGraph(episode.id, targetMode);
  if (!baseGraph) {
    const legacyState = targetMode === 'image' ? episode.imageCanvas : episode.videoCanvas;
    baseGraph = buildInitialCanvasGraph(episode as ProjectState, targetMode, legacyState);
  } else {
    baseGraph = mergeGraphWithProject(baseGraph, episode as ProjectState, targetMode);
  }

  const existingNodeMap = new Map<string, CanvasNodeEntity>(
    baseGraph.nodes.map((node) => [node.id, node])
  );
  const updatedNodes: CanvasNodeEntity[] = [];
  const updatedEdges: CanvasEdgeEntity[] = [...baseGraph.edges];
  const legacyNodePositions: Record<string, { x: number; y: number }> = {
    ...(baseGraph.legacyNodePositions || {}),
  };

  // 辅助查找已存在节点（优先 sourceRef 匹配，其次稳定投影 ID，再次旧版 ID）
  const findExistingNode = (
    predicate: (n: CanvasNodeEntity) => boolean,
    candidateIds: string[]
  ): CanvasNodeEntity | undefined => {
    // 优先从 candidateIds 匹配
    for (const id of candidateIds) {
      const match = existingNodeMap.get(id);
      if (match) return match;
    }
    // 其次按特征 predicate 匹配（如 sourceRef）
    for (const node of existingNodeMap.values()) {
      if (predicate(node)) return node;
    }
    return undefined;
  };

  // 2. 布局左侧：角色 / 场景 / 道具参考节点
  let refSlotIndex = 0;
  const referenceNodeIds: {
    characters: Map<string, string>;
    scenes: Map<string, string>;
    props: Map<string, string>;
  } = {
    characters: new Map(),
    scenes: new Map(),
    props: new Map(),
  };

  // 2.1 角色参考节点
  const characters = episode.scriptData?.characters || [];
  characters.forEach((char) => {
    const projectionId = buildProjectionNodeId(scopeKey, `char_${char.id}`);
    const existing = findExistingNode(
      (n) =>
        n.type === 'reference_slot' &&
        (n.data?.assetId === char.id || (n.data?.assetType === 'character' && n.data?.title === `角色: ${char.name}`)),
      [projectionId]
    );

    const nodeId = existing ? existing.id : projectionId;
    const defaultPos = { x: 40, y: 50 + refSlotIndex * 210 };
    const pos = existing?.position || legacyNodePositions[nodeId] || defaultPos;

    const charNode: CanvasNodeEntity = {
      id: nodeId,
      graphId: baseGraph.id,
      type: 'reference_slot',
      position: pos,
      size: existing?.size || { width: NODE_WIDTH, height: NODE_HEIGHT },
      sourceRef: {
        episodeId: episode.id,
      },
      data: {
        ...(existing?.data || {}),
        title: `角色: ${char.name}`,
        subtitle: char.personality || char.visualPrompt || '角色外观参考',
        imageUrl: char.referenceImage,
        status: char.referenceImage ? '已就绪' : '待配置',
        assetType: 'character',
        assetId: char.id,
        isBundle: false,
        slotNumber: refSlotIndex + 1,
      },
    };

    if (!existing) {
      createdNodeIds.push(nodeId);
    } else {
      existingNodeMap.delete(existing.id);
    }

    updatedNodes.push(charNode);
    legacyNodePositions[nodeId] = pos;
    referenceNodeIds.characters.set(char.id, nodeId);
    refSlotIndex++;
  });

  // 2.2 场景参考节点
  const scenes = episode.scriptData?.scenes || [];
  scenes.forEach((scene) => {
    const projectionId = buildProjectionNodeId(scopeKey, `scene_${scene.id}`);
    const existing = findExistingNode(
      (n) =>
        n.type === 'reference_slot' &&
        (n.data?.assetId === scene.id || (n.data?.assetType === 'scene' && n.data?.title === `场景: ${scene.location}`)),
      [projectionId]
    );

    const nodeId = existing ? existing.id : projectionId;
    const defaultPos = { x: 40, y: 50 + refSlotIndex * 210 };
    const pos = existing?.position || legacyNodePositions[nodeId] || defaultPos;

    const sceneNode: CanvasNodeEntity = {
      id: nodeId,
      graphId: baseGraph.id,
      type: 'reference_slot',
      position: pos,
      size: existing?.size || { width: NODE_WIDTH, height: NODE_HEIGHT },
      sourceRef: {
        episodeId: episode.id,
      },
      data: {
        ...(existing?.data || {}),
        title: `场景: ${scene.location}`,
        subtitle: scene.atmosphere || scene.visualPrompt || '场景背景参考',
        imageUrl: scene.referenceImage,
        status: scene.referenceImage ? '已就绪' : '待配置',
        assetType: 'scene',
        assetId: scene.id,
        isBundle: false,
        slotNumber: refSlotIndex + 1,
      },
    };

    if (!existing) {
      createdNodeIds.push(nodeId);
    } else {
      existingNodeMap.delete(existing.id);
    }

    updatedNodes.push(sceneNode);
    legacyNodePositions[nodeId] = pos;
    referenceNodeIds.scenes.set(scene.id, nodeId);
    refSlotIndex++;
  });

  // 2.3 道具参考节点
  const props = episode.scriptData?.props || [];
  props.forEach((prop) => {
    const projectionId = buildProjectionNodeId(scopeKey, `prop_${prop.id}`);
    const existing = findExistingNode(
      (n) =>
        n.type === 'reference_slot' &&
        (n.data?.assetId === prop.id || (n.data?.assetType === 'prop' && n.data?.title === `道具: ${prop.name}`)),
      [projectionId]
    );

    const nodeId = existing ? existing.id : projectionId;
    const defaultPos = { x: 40, y: 50 + refSlotIndex * 210 };
    const pos = existing?.position || legacyNodePositions[nodeId] || defaultPos;

    const propNode: CanvasNodeEntity = {
      id: nodeId,
      graphId: baseGraph.id,
      type: 'reference_slot',
      position: pos,
      size: existing?.size || { width: NODE_WIDTH, height: NODE_HEIGHT },
      sourceRef: {
        episodeId: episode.id,
      },
      data: {
        ...(existing?.data || {}),
        title: `道具: ${prop.name}`,
        subtitle: prop.description || prop.visualPrompt || '道具参考',
        imageUrl: prop.referenceImage,
        status: prop.referenceImage ? '已就绪' : '待配置',
        assetType: 'prop',
        assetId: prop.id,
        isBundle: false,
        slotNumber: refSlotIndex + 1,
      },
    };

    if (!existing) {
      createdNodeIds.push(nodeId);
    } else {
      existingNodeMap.delete(existing.id);
    }

    updatedNodes.push(propNode);
    legacyNodePositions[nodeId] = pos;
    referenceNodeIds.props.set(prop.id, nodeId);
    refSlotIndex++;
  });

  // 2.4 全局资产包节点（若已有则保留）
  const bundleId = `reference-bundle-${targetMode}`;
  const existingBundle = existingNodeMap.get(bundleId);
  if (existingBundle) {
    updatedNodes.push(existingBundle);
    existingNodeMap.delete(bundleId);
    legacyNodePositions[bundleId] = existingBundle.position;
  }

  // 3. 布局右侧：按分镜时序的 shot_projection 节点与首帧 / 视频 artifact
  const shots = episode.shots || [];
  let focusedNodeId: string | undefined;

  shots.forEach((shot, index) => {
    const defaultY = 50 + index * 260;
    const shotProjId = buildProjectionNodeId(scopeKey, `shot_${shot.id}`);
    const imageProjId = buildProjectionNodeId(scopeKey, `image_${shot.id}`);
    const videoProjId = buildProjectionNodeId(scopeKey, `video_${shot.id}`);

    const legacyShotId = `shot-${shot.id}`;
    const legacyImageId = `image-${shot.id}`;
    const legacyVideoId = `video-${shot.id}`;

    // 3.1 查找或新建分镜节点
    const existingShot = findExistingNode(
      (n) => n.type === 'shot_projection' && n.sourceRef?.shotId === shot.id,
      [shotProjId, legacyShotId]
    );

    const shotNodeId = existingShot ? existingShot.id : shotProjId;
    const shotPos = existingShot?.position || legacyNodePositions[shotNodeId] || { x: 360, y: defaultY };
    const startFrame = getStartFrame(shot);

    const shotNode: CanvasNodeEntity = {
      id: shotNodeId,
      graphId: baseGraph.id,
      type: 'shot_projection',
      position: shotPos,
      size: existingShot?.size || { width: NODE_WIDTH, height: NODE_HEIGHT },
      sourceRef: {
        episodeId: episode.id,
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
    };

    if (!existingShot) {
      createdNodeIds.push(shotNodeId);
    } else {
      existingNodeMap.delete(existingShot.id);
    }
    updatedNodes.push(shotNode);
    legacyNodePositions[shotNodeId] = shotPos;

    // 命中目标镜头聚焦
    if (opts?.targetShotId && shot.id === opts.targetShotId) {
      focusedNodeId = shotNodeId;
    }

    // 3.2 查找或新建生图产物节点
    const existingImage = findExistingNode(
      (n) =>
        n.type === 'artifact_output' &&
        n.sourceRef?.shotId === shot.id &&
        n.data?.mediaType === 'image',
      [imageProjId, legacyImageId]
    );

    const imageNodeId = existingImage ? existingImage.id : imageProjId;
    const imagePos = existingImage?.position || legacyNodePositions[imageNodeId] || { x: 680, y: defaultY };

    const imageNode: CanvasNodeEntity = {
      id: imageNodeId,
      graphId: baseGraph.id,
      type: 'artifact_output',
      position: imagePos,
      size: existingImage?.size || { width: NODE_WIDTH, height: ARTIFACT_NODE_HEIGHT },
      sourceRef: {
        episodeId: episode.id,
        shotId: shot.id,
      },
      data: {
        ...(existingImage?.data || {}),
        shotId: shot.id,
        title: '生图 / 关键帧',
        subtitle: startFrame?.visualPrompt || '从镜头动作与资产上下文生成',
        status: getImageStatus(shot),
        imageUrl: startFrame?.imageUrl,
        mediaType: 'image',
      },
    };

    if (!existingImage) {
      createdNodeIds.push(imageNodeId);
    } else {
      existingNodeMap.delete(existingImage.id);
    }
    updatedNodes.push(imageNode);
    legacyNodePositions[imageNodeId] = imagePos;

    // 3.3 建立连线：镜头 -> 首帧图像 artifact
    ensureEdge(updatedEdges, shotNodeId, 'output-image', imageNodeId, 'slot-1');

    // 3.4 视频模式：查找或新建生视频产物节点
    if (targetMode === 'video') {
      const existingVideo = findExistingNode(
        (n) =>
          n.type === 'artifact_output' &&
          n.sourceRef?.shotId === shot.id &&
          n.data?.mediaType === 'video',
        [videoProjId, legacyVideoId]
      );

      const videoNodeId = existingVideo ? existingVideo.id : videoProjId;
      const videoPos = existingVideo?.position || legacyNodePositions[videoNodeId] || { x: 1000, y: defaultY };

      const videoNode: CanvasNodeEntity = {
        id: videoNodeId,
        graphId: baseGraph.id,
        type: 'artifact_output',
        position: videoPos,
        size: existingVideo?.size || { width: NODE_WIDTH, height: ARTIFACT_NODE_HEIGHT },
        sourceRef: {
          episodeId: episode.id,
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
      };

      if (!existingVideo) {
        createdNodeIds.push(videoNodeId);
      } else {
        existingNodeMap.delete(existingVideo.id);
      }
      updatedNodes.push(videoNode);
      legacyNodePositions[videoNodeId] = videoPos;

      // 建立连线：镜头 -> 视频 artifact
      ensureEdge(updatedEdges, shotNodeId, 'output-video', videoNodeId, 'slot-1');
    }

    // 3.5 建立连线：参考资产 -> 镜头
    let hasRefConnection = false;

    // 角色关联连线
    if (Array.isArray(shot.characters)) {
      shot.characters.forEach((charId) => {
        const charNodeId = referenceNodeIds.characters.get(charId);
        if (charNodeId) {
          ensureEdge(updatedEdges, charNodeId, 'output-image', shotNodeId, 'slot-1');
          hasRefConnection = true;
        }
      });
    }

    // 场景关联连线
    if (shot.sceneId) {
      const sceneNodeId = referenceNodeIds.scenes.get(shot.sceneId);
      if (sceneNodeId) {
        ensureEdge(
          updatedEdges,
          sceneNodeId,
          'output-image',
          shotNodeId,
          hasRefConnection ? 'slot-2' : 'slot-1'
        );
        hasRefConnection = true;
      }
    }

    // 道具关联连线
    if (Array.isArray(shot.props)) {
      shot.props.forEach((propId) => {
        const propNodeId = referenceNodeIds.props.get(propId);
        if (propNodeId) {
          ensureEdge(updatedEdges, propNodeId, 'output-image', shotNodeId, 'slot-2');
          hasRefConnection = true;
        }
      });
    }

    // 若无单独资产连线且存在全局 bundle，连向 bundle
    if (!hasRefConnection && existingBundle) {
      ensureEdge(updatedEdges, existingBundle.id, 'output-image', shotNodeId, 'slot-1');
    }
  });

  // 4. 保留所有用户自定义节点（如 config_node、自定义 reference_slot 等，避免破坏创作者数据）
  for (const remainingNode of existingNodeMap.values()) {
    updatedNodes.push(remainingNode);
    legacyNodePositions[remainingNode.id] = remainingNode.position;
  }

  // 5. 过滤孤立无效边
  const validNodeIds = new Set(updatedNodes.map((n) => n.id));
  const validEdges = updatedEdges.filter(
    (e) => validNodeIds.has(e.sourceNodeId) && validNodeIds.has(e.targetNodeId)
  );

  // 6. 确定聚焦视口
  let viewport = baseGraph.viewport || DEFAULT_VIEWPORT;
  if (!focusedNodeId && createdNodeIds.length > 0) {
    focusedNodeId = createdNodeIds[0];
  } else if (!focusedNodeId && updatedNodes.length > 0) {
    const firstShot = updatedNodes.find((n) => n.type === 'shot_projection');
    if (firstShot) focusedNodeId = firstShot.id;
  }

  if (focusedNodeId) {
    const targetNode = updatedNodes.find((n) => n.id === focusedNodeId);
    if (targetNode) {
      viewport = {
        x: Math.round(450 - targetNode.position.x * 0.8),
        y: Math.round(280 - targetNode.position.y * 0.8),
        zoom: 0.8,
      };
    }
  }

  // 7. 组装合并结果并持久化至 IndexedDB
  const finalGraph: CanvasGraphEntity = {
    ...baseGraph,
    nodes: updatedNodes,
    edges: validEdges,
    viewport,
    legacyNodePositions,
    updatedAt: Date.now(),
  };

  await saveCanvasGraph(finalGraph);

  return {
    graph: finalGraph,
    createdNodeIds,
    focusedNodeId,
  };
}

/**
 * 导演台 ➔ 画布 1:1 投影服务核心接口 (T20 规范实现)
 *
 * @param episode 当前分集数据
 * @param mode 投影模态：'image' | 'video' | 'all'
 * @param opts 投影配置选项（如指定聚焦镜头）
 * @returns 投影后的画布图实体、新创建节点 ID 列表及当前聚焦节点 ID
 */
export async function projectEpisodeToCanvas(
  episode: Episode,
  mode: 'image' | 'video' | 'all',
  opts?: ProjectEpisodeToCanvasOptions
): Promise<ProjectionResult> {
  if (mode === 'all') {
    // 双模态投影：同时同步 'image' 与 'video' 画布图
    const [imageResult, videoResult] = await Promise.all([
      projectEpisodeToCanvasForMode(episode, 'image', opts),
      projectEpisodeToCanvasForMode(episode, 'video', opts),
    ]);

    const createdNodeIds = Array.from(
      new Set([...imageResult.createdNodeIds, ...videoResult.createdNodeIds])
    );

    return {
      graph: imageResult.graph,
      createdNodeIds,
      focusedNodeId: imageResult.focusedNodeId || videoResult.focusedNodeId,
    };
  }

  return projectEpisodeToCanvasForMode(episode, mode, opts);
}
