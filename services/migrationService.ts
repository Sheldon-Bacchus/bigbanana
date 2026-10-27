import { SeriesProject, Series, Episode, Character, CanvasGraphEntity, MediaVersionEntity } from '../types';
import { normalizeChatModelId } from './modelIdUtils';
import { createTypedId } from './uuidUtils';

const generateId = (prefix: string): string => {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
};

interface LegacyProjectState {
  id: string;
  title: string;
  createdAt: number;
  lastModified: number;
  stage: string;
  rawScript: string;
  targetDuration: string;
  language: string;
  visualStyle: string;
  shotGenerationModel: string;
  scriptData: {
    title: string;
    genre: string;
    logline: string;
    targetDuration?: string;
    language?: string;
    visualStyle?: string;
    shotGenerationModel?: string;
    artDirection?: any;
    characters: Character[];
    scenes: any[];
    props: any[];
    storyParagraphs: any[];
  } | null;
  shots: any[];
  isParsingScript: boolean;
  renderLogs: any[];
}

const buildDefaultEpisodeTitle = (episodeNumber: number): string => `第 ${episodeNumber} 集`;

const isDefaultEpisodeTitle = (title: string): boolean => {
  return /^第\s*\d+\s*集$/u.test(title.trim());
};

export async function runV2ToV3Migration(db: IDBDatabase): Promise<void> {
  if (!db.objectStoreNames.contains('projects')) return;
  if (!db.objectStoreNames.contains('seriesProjects')) return;

  const alreadyMigrated = await new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction('seriesProjects', 'readonly');
    const req = tx.objectStore('seriesProjects').count();
    req.onsuccess = () => resolve(req.result > 0);
    req.onerror = () => reject(req.error);
  });
  if (alreadyMigrated) return;

  const legacyProjects = await new Promise<LegacyProjectState[]>((resolve, reject) => {
    const tx = db.transaction('projects', 'readonly');
    const store = tx.objectStore('projects');
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result || []) as LegacyProjectState[]);
    req.onerror = () => reject(req.error);
  });

  if (legacyProjects.length === 0) return;

  console.log(`Migrating ${legacyProjects.length} legacy projects to v3...`);

  const tx = db.transaction(['seriesProjects', 'series', 'episodes'], 'readwrite');
  const spStore = tx.objectStore('seriesProjects');
  const seriesStore = tx.objectStore('series');
  const epStore = tx.objectStore('episodes');

  for (const legacy of legacyProjects) {
    try {
      if (legacy.shots) {
        legacy.shots.forEach((shot: any) => {
          if (shot.videoModel === 'veo-r2v' || shot.videoModel === 'veo') {
            shot.videoModel = 'veo_3_1-fast';
          }
        });
      }
      if (!legacy.renderLogs) legacy.renderLogs = [];
      if (legacy.scriptData && !legacy.scriptData.props) legacy.scriptData.props = [];

      const now = Date.now();
      const projectId = generateId('sproj');
      const seriesId = generateId('series');
      const episodeId = generateId('ep');

      const characters = legacy.scriptData?.characters || [];
      const scenes = legacy.scriptData?.scenes || [];
      const props = legacy.scriptData?.props || [];

      const libraryChars: Character[] = characters.map(c => ({ ...c, version: 1 }));
      const episodeChars: Character[] = characters.map(c => ({ ...c, libraryId: c.id, libraryVersion: 1 }));
      const libraryScenes = scenes.map(s => ({ ...s, version: 1 }));
      const episodeScenes = scenes.map(s => ({ ...s, libraryId: s.id, libraryVersion: 1 }));
      const libraryProps = props.map(p => ({ ...p, version: 1 }));
      const episodeProps = props.map(p => ({ ...p, libraryId: p.id, libraryVersion: 1 }));
      const characterRefs = characters.map(c => ({
        characterId: c.id,
        syncedVersion: 1,
        syncStatus: 'synced' as const,
      }));
      const sceneRefs = scenes.map(s => ({
        sceneId: s.id,
        syncedVersion: 1,
        syncStatus: 'synced' as const,
      }));
      const propRefs = props.map(p => ({
        propId: p.id,
        syncedVersion: 1,
        syncStatus: 'synced' as const,
      }));

      const sp: SeriesProject = {
        id: projectId,
        title: legacy.title,
        createdAt: legacy.createdAt,
        lastModified: legacy.lastModified,
        visualStyle: legacy.visualStyle || '3d-animation',
        language: legacy.language || '中文',
        artDirection: legacy.scriptData?.artDirection,
        characterLibrary: libraryChars,
        sceneLibrary: libraryScenes,
        propLibrary: libraryProps,
      };

      const s: Series = {
        id: seriesId,
        projectId,
        title: '第一季',
        sortOrder: 0,
        createdAt: now,
        lastModified: now,
      };

      const ep: Episode = {
        id: episodeId,
        projectId,
        seriesId,
        episodeNumber: 1,
        title: buildDefaultEpisodeTitle(1),
        createdAt: legacy.createdAt,
        lastModified: legacy.lastModified,
        stage: (legacy.stage as Episode['stage']) || 'script',
        rawScript: legacy.rawScript,
        targetDuration: legacy.targetDuration,
        language: legacy.language,
        visualStyle: legacy.visualStyle,
        shotGenerationModel: normalizeChatModelId(legacy.shotGenerationModel) || 'gpt-5.2',
        scriptData: legacy.scriptData ? { ...legacy.scriptData, characters: episodeChars, scenes: episodeScenes, props: episodeProps } : null,
        shots: legacy.shots || [],
        isParsingScript: false,
        renderLogs: legacy.renderLogs || [],
        characterRefs,
        sceneRefs,
        propRefs,
        scriptGenerationCheckpoint: null,
      };

      spStore.put(sp);
      seriesStore.put(s);
      epStore.put(ep);
    } catch (e) {
      console.error(`Failed to migrate project "${legacy.title}":`, e);
    }
  }

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      console.log(`Migration complete: ${legacyProjects.length} projects migrated.`);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function runEpisodeTitleFixMigration(db: IDBDatabase): Promise<void> {
  if (!db.objectStoreNames.contains('seriesProjects')) return;
  if (!db.objectStoreNames.contains('episodes')) return;

  const projects = await new Promise<SeriesProject[]>((resolve, reject) => {
    const tx = db.transaction('seriesProjects', 'readonly');
    const req = tx.objectStore('seriesProjects').getAll();
    req.onsuccess = () => resolve((req.result || []) as SeriesProject[]);
    req.onerror = () => reject(req.error);
  });

  if (projects.length === 0) return;

  const projectTitleMap = new Map<string, string>(
    projects.map(p => [p.id, (p.title || '').trim()])
  );

  const episodes = await new Promise<Episode[]>((resolve, reject) => {
    const tx = db.transaction('episodes', 'readonly');
    const req = tx.objectStore('episodes').getAll();
    req.onsuccess = () => resolve((req.result || []) as Episode[]);
    req.onerror = () => reject(req.error);
  });

  if (episodes.length === 0) return;

  const updates = episodes
    .filter(ep => (ep.episodeNumber || 0) === 1)
    .filter(ep => {
      const epTitle = (ep.title || '').trim();
      if (!epTitle) return true;
      if (isDefaultEpisodeTitle(epTitle)) return false;

      const projectTitle = projectTitleMap.get(ep.projectId) || '';
      return !!projectTitle && epTitle === projectTitle;
    })
    .map(ep => ({
      ...ep,
      title: buildDefaultEpisodeTitle(ep.episodeNumber || 1),
    }));

  if (updates.length === 0) return;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('episodes', 'readwrite');
    const store = tx.objectStore('episodes');
    updates.forEach(ep => store.put(ep));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  console.log(`Episode title fix migration applied: ${updates.length} episode(s) updated.`);
}

export interface V4BaselineData {
  canvasGraphs: CanvasGraphEntity[];
  mediaVersions: MediaVersionEntity[];
}

/**
 * 遍历 episodes 提取存量 imageCanvas/videoCanvas 与媒体基线版本
 * 遵循 006 规格数据模型第 4.1 节与幂等策略
 */
export function generateV4BaselineFromEpisodes(
  episodes: Episode[],
  existingGraphs?: CanvasGraphEntity[],
  existingVersions?: MediaVersionEntity[]
): V4BaselineData {
  const existingGraphKeySet = new Set<string>();
  (existingGraphs || []).forEach(g => {
    existingGraphKeySet.add(`${g.episodeId}:::${g.mode}`);
  });

  const existingVersionTargetSet = new Set<string>();
  (existingVersions || []).forEach(v => {
    existingVersionTargetSet.add(`${v.targetType}:::${v.targetId}`);
  });

  const generatedGraphs: CanvasGraphEntity[] = [];
  const generatedVersions: MediaVersionEntity[] = [];
  const now = Date.now();

  for (const ep of episodes) {
    if (!ep || !ep.id) continue;

    // 1. 处理存量 imageCanvas -> CanvasGraphEntity
    if (ep.imageCanvas) {
      const key = `${ep.id}:::image`;
      if (!existingGraphKeySet.has(key)) {
        existingGraphKeySet.add(key);
        generatedGraphs.push({
          id: createTypedId('cgraph'),
          episodeId: ep.id,
          mode: 'image',
          viewport: ep.imageCanvas.viewport ? { ...ep.imageCanvas.viewport } : { x: 0, y: 0, zoom: 1 },
          nodes: [],
          edges: [],
          updatedAt: ep.imageCanvas.updatedAt || now,
          legacyNodePositions: ep.imageCanvas.nodePositions ? { ...ep.imageCanvas.nodePositions } : {},
        });
      }
    }

    // 2. 处理存量 videoCanvas -> CanvasGraphEntity
    if (ep.videoCanvas) {
      const key = `${ep.id}:::video`;
      if (!existingGraphKeySet.has(key)) {
        existingGraphKeySet.add(key);
        generatedGraphs.push({
          id: createTypedId('cgraph'),
          episodeId: ep.id,
          mode: 'video',
          viewport: ep.videoCanvas.viewport ? { ...ep.videoCanvas.viewport } : { x: 0, y: 0, zoom: 1 },
          nodes: [],
          edges: [],
          updatedAt: ep.videoCanvas.updatedAt || now,
          legacyNodePositions: ep.videoCanvas.nodePositions ? { ...ep.videoCanvas.nodePositions } : {},
        });
      }
    }

    // 3. 处理存量媒体版本基线
    if (Array.isArray(ep.shots)) {
      for (const shot of ep.shots) {
        if (!shot) continue;

        // 3.1 关键帧: keyframes 有 imageUrl -> targetType 'keyframe'、targetId=keyframe.id
        if (Array.isArray(shot.keyframes)) {
          for (const kf of shot.keyframes) {
            if (kf && kf.id && kf.imageUrl) {
              const vKey = `keyframe:::${kf.id}`;
              if (!existingVersionTargetSet.has(vKey)) {
                existingVersionTargetSet.add(vKey);
                generatedVersions.push({
                  id: createTypedId('mver'),
                  targetType: 'keyframe',
                  targetId: kf.id,
                  versionNumber: 1,
                  mediaType: 'image',
                  storageRef: kf.imageUrl,
                  provenance: {
                    source: 'workbench_manual',
                    promptSnapshot: kf.visualPrompt,
                  },
                  isCurrent: true,
                  createdAt: now,
                });
              }
            }
          }
        }

        // 3.2 视频片段: interval.videoUrl -> targetType 'interval'、targetId=shot.id
        if (shot.interval && shot.interval.videoUrl) {
          const vKey = `interval:::${shot.id}`;
          if (!existingVersionTargetSet.has(vKey)) {
            existingVersionTargetSet.add(vKey);
            generatedVersions.push({
              id: createTypedId('mver'),
              targetType: 'interval',
              targetId: shot.id,
              versionNumber: 1,
              mediaType: 'video',
              storageRef: shot.interval.videoUrl,
              provenance: {
                source: 'workbench_manual',
                promptSnapshot: shot.interval.videoPrompt,
              },
              isCurrent: true,
              createdAt: now,
            });
          }
        }
      }
    }
  }

  return {
    canvasGraphs: generatedGraphs,
    mediaVersions: generatedVersions,
  };
}

/**
 * BigBananaDB v3 -> v4 迁移执行函数
 * 平滑迁移存量 imageCanvas/videoCanvas 到 canvas_graphs，并初始化 MediaVersion 基线
 */
export async function runV3ToV4Migration(db: IDBDatabase): Promise<void> {
  try {
    if (!db.objectStoreNames.contains('canvas_graphs')) return;
    if (!db.objectStoreNames.contains('episodes') || !db.objectStoreNames.contains('media_versions')) return;

    const episodes = await new Promise<Episode[]>((resolve, reject) => {
      const tx = db.transaction('episodes', 'readonly');
      const req = tx.objectStore('episodes').getAll();
      req.onsuccess = () => resolve((req.result || []) as Episode[]);
      req.onerror = () => reject(req.error);
    });

    if (episodes.length === 0) return;

    const existingGraphs = await new Promise<CanvasGraphEntity[]>((resolve, reject) => {
      const tx = db.transaction('canvas_graphs', 'readonly');
      const req = tx.objectStore('canvas_graphs').getAll();
      req.onsuccess = () => resolve((req.result || []) as CanvasGraphEntity[]);
      req.onerror = () => reject(req.error);
    });

    const existingVersions = await new Promise<MediaVersionEntity[]>((resolve, reject) => {
      const tx = db.transaction('media_versions', 'readonly');
      const req = tx.objectStore('media_versions').getAll();
      req.onsuccess = () => resolve((req.result || []) as MediaVersionEntity[]);
      req.onerror = () => reject(req.error);
    });

    const { canvasGraphs, mediaVersions } = generateV4BaselineFromEpisodes(
      episodes,
      existingGraphs,
      existingVersions
    );

    if (canvasGraphs.length === 0 && mediaVersions.length === 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['canvas_graphs', 'media_versions'], 'readwrite');
      const graphStore = tx.objectStore('canvas_graphs');
      const mediaStore = tx.objectStore('media_versions');

      canvasGraphs.forEach(g => graphStore.put(g));
      mediaVersions.forEach(v => mediaStore.put(v));

      tx.oncomplete = () => {
        console.log(`v3 to v4 migration complete: ${canvasGraphs.length} canvas graph(s) and ${mediaVersions.length} media version(s) migrated.`);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('v3 to v4 migration warning (non-fatal):', e);
  }
}
