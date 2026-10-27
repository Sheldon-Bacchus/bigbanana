import {
  ProjectState,
  AssetLibraryItem,
  SeriesProject,
  Series,
  Episode,
  CanvasGraphEntity,
  GenerationTaskEntity,
  MediaVersionEntity,
  CommitRecordEntity,
} from '../types';
import {
  runV2ToV3Migration,
  runEpisodeTitleFixMigration,
  runV3ToV4Migration,
  generateV4BaselineFromEpisodes,
} from './migrationService';
import { materializeProjectVideosForExport, migrateProjectVideosToOPFS } from './videoStorageService';
import { reconcileShotSceneIds } from './storyboardIdUtils';
import { sanitizePromptTemplateOverrides } from './promptTemplateService';
import { normalizeChatModelId } from './modelIdUtils';

export const DB_NAME = 'BigBananaDB';
export const DB_VERSION = 4;
export const STORE_NAME = 'projects';
export const ASSET_STORE_NAME = 'assetLibrary';
export const SP_STORE = 'seriesProjects';
export const SERIES_STORE = 'series';
export const EP_STORE = 'episodes';
export const CANVAS_GRAPH_STORE = 'canvas_graphs';
export const GENERATION_TASK_STORE = 'generation_tasks';
export const MEDIA_VERSION_STORE = 'media_versions';
export const COMMIT_RECORD_STORE = 'commit_records';
export const EXPORT_SCHEMA_VERSION = 4;

export interface IndexedDBExportPayload {
  schemaVersion: number;
  exportedAt: number;
  scope?: 'all' | 'project' | 'episode';
  dbName: string;
  dbVersion: number;
  stores: {
    projects: ProjectState[];
    assetLibrary: AssetLibraryItem[];
    seriesProjects?: SeriesProject[];
    series?: Series[];
    episodes?: Episode[];
    canvasGraphs?: CanvasGraphEntity[];
    generationTasks?: GenerationTaskEntity[];
    mediaVersions?: MediaVersionEntity[];
    commitRecords?: CommitRecordEntity[];
  };
}

let dbPromise: Promise<IDBDatabase> | null = null;

const openDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => { dbPromise = null; reject(request.error); };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => { dbPromise = null; };
      Promise.resolve()
        .then(() => runV2ToV3Migration(db).catch(e => console.error('Migration error (v2->v3, non-fatal):', e)))
        .then(() => runEpisodeTitleFixMigration(db).catch(e => console.error('Migration error (title fix, non-fatal):', e)))
        .then(() => runV3ToV4Migration(db).catch(e => console.error('Migration error (v3->v4, non-fatal):', e)))
        .then(() => resolve(db))
        .catch((e) => { console.error('Migration chain unexpected error (non-fatal):', e); resolve(db); });
    };
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const tx = (event.target as IDBOpenDBRequest).transaction;
      if (!tx) return;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(ASSET_STORE_NAME)) {
        db.createObjectStore(ASSET_STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SP_STORE)) {
        db.createObjectStore(SP_STORE, { keyPath: 'id' });
      }

      const ss = !db.objectStoreNames.contains(SERIES_STORE)
        ? db.createObjectStore(SERIES_STORE, { keyPath: 'id' })
        : tx.objectStore(SERIES_STORE);
      if (!ss.indexNames.contains('projectId')) {
        ss.createIndex('projectId', 'projectId', { unique: false });
      }

      const es = !db.objectStoreNames.contains(EP_STORE)
        ? db.createObjectStore(EP_STORE, { keyPath: 'id' })
        : tx.objectStore(EP_STORE);
      if (!es.indexNames.contains('projectId')) {
        es.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!es.indexNames.contains('seriesId')) {
        es.createIndex('seriesId', 'seriesId', { unique: false });
      }

      const cgs = !db.objectStoreNames.contains(CANVAS_GRAPH_STORE)
        ? db.createObjectStore(CANVAS_GRAPH_STORE, { keyPath: 'id' })
        : tx.objectStore(CANVAS_GRAPH_STORE);
      if (!cgs.indexNames.contains('episodeId')) {
        cgs.createIndex('episodeId', 'episodeId', { unique: false });
      }
      if (!cgs.indexNames.contains('episodeId_mode')) {
        cgs.createIndex('episodeId_mode', ['episodeId', 'mode'], { unique: false });
      }

      const gts = !db.objectStoreNames.contains(GENERATION_TASK_STORE)
        ? db.createObjectStore(GENERATION_TASK_STORE, { keyPath: 'id' })
        : tx.objectStore(GENERATION_TASK_STORE);
      if (!gts.indexNames.contains('graphId')) {
        gts.createIndex('graphId', 'graphId', { unique: false });
      }
      if (!gts.indexNames.contains('status')) {
        gts.createIndex('status', 'status', { unique: false });
      }

      const mvs = !db.objectStoreNames.contains(MEDIA_VERSION_STORE)
        ? db.createObjectStore(MEDIA_VERSION_STORE, { keyPath: 'id' })
        : tx.objectStore(MEDIA_VERSION_STORE);
      if (!mvs.indexNames.contains('targetId')) {
        mvs.createIndex('targetId', 'targetId', { unique: false });
      }
      if (!mvs.indexNames.contains('targetType_targetId')) {
        mvs.createIndex('targetType_targetId', ['targetType', 'targetId'], { unique: false });
      }

      const crs = !db.objectStoreNames.contains(COMMIT_RECORD_STORE)
        ? db.createObjectStore(COMMIT_RECORD_STORE, { keyPath: 'id' })
        : tx.objectStore(COMMIT_RECORD_STORE);
      if (!crs.indexNames.contains('targetId')) {
        crs.createIndex('targetId', 'targetId', { unique: false });
      }
      if (!crs.indexNames.contains('status')) {
        crs.createIndex('status', 'status', { unique: false });
      }
    };
  });

  return dbPromise;
};

const mergeByKey = <T>(
  existing: T[] | undefined,
  inferred: T[],
  getKey: (item: T) => string
): T[] => {
  const merged = new Map<string, T>();
  inferred.forEach(item => merged.set(getKey(item), item));
  (existing || []).forEach(item => merged.set(getKey(item), item));
  return Array.from(merged.values());
};

const normalizeEpisode = (ep: Episode): Episode => {
  const scriptData = ep.scriptData
    ? {
        ...ep.scriptData,
        props: ep.scriptData.props || [],
      }
    : null;

  const inferredCharacterRefs = (scriptData?.characters || [])
    .filter(c => !!c.libraryId)
    .map(c => ({
      characterId: c.libraryId!,
      syncedVersion: c.libraryVersion || 1,
      syncStatus: 'synced' as const,
    }));

  const inferredSceneRefs = (scriptData?.scenes || [])
    .filter(s => !!s.libraryId)
    .map(s => ({
      sceneId: s.libraryId!,
      syncedVersion: s.libraryVersion || 1,
      syncStatus: 'synced' as const,
    }));

  const inferredPropRefs = (scriptData?.props || [])
    .filter(p => !!p.libraryId)
    .map(p => ({
      propId: p.libraryId!,
      syncedVersion: p.libraryVersion || 1,
      syncStatus: 'synced' as const,
    }));

  return {
    ...ep,
    scriptData,
    shots: reconcileShotSceneIds(ep.shots || [], scriptData?.scenes || []),
    renderLogs: ep.renderLogs || [],
    characterRefs: mergeByKey(ep.characterRefs, inferredCharacterRefs, r => r.characterId),
    sceneRefs: mergeByKey(ep.sceneRefs, inferredSceneRefs, r => r.sceneId),
    propRefs: mergeByKey(ep.propRefs, inferredPropRefs, r => r.propId),
    promptTemplateOverrides: sanitizePromptTemplateOverrides(ep.promptTemplateOverrides),
  };
};

const normalizeAndPersistEpisodeVideos = async (ep: Episode): Promise<Episode> => {
  const normalized = normalizeEpisode(ep);
  try {
    const { project } = await migrateProjectVideosToOPFS(normalized);
    return project as Episode;
  } catch (error) {
    console.warn('Normalize episode video storage failed, use original episode data.', error);
    return normalized;
  }
};

// =============================================
// SeriesProject CRUD
// =============================================

export const saveSeriesProject = async (sp: SeriesProject): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SP_STORE, 'readwrite');
    tx.objectStore(SP_STORE).put({ ...sp, lastModified: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const loadSeriesProject = async (id: string): Promise<SeriesProject> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SP_STORE, 'readonly');
    const req = tx.objectStore(SP_STORE).get(id);
    req.onsuccess = () => {
      if (req.result) resolve(req.result as SeriesProject);
      else reject(new Error('SeriesProject not found'));
    };
    req.onerror = () => reject(req.error);
  });
};

export const getAllSeriesProjects = async (): Promise<SeriesProject[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SP_STORE, 'readonly');
    const req = tx.objectStore(SP_STORE).getAll();
    req.onsuccess = () => {
      const items = (req.result as SeriesProject[]) || [];
      items.sort((a, b) => b.lastModified - a.lastModified);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
};

export const deleteSeriesProject = async (id: string): Promise<void> => {
  const db = await openDB();

  const seriesList = await getSeriesByProject(id);
  const episodes = await getEpisodesByProject(id);

  return new Promise((resolve, reject) => {
    const stores = [SP_STORE, SERIES_STORE, EP_STORE];
    const tx = db.transaction(stores, 'readwrite');
    tx.objectStore(SP_STORE).delete(id);
    for (const s of seriesList) tx.objectStore(SERIES_STORE).delete(s.id);
    for (const ep of episodes) tx.objectStore(EP_STORE).delete(ep.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const createNewSeriesProject = (title?: string): SeriesProject => {
  const now = new Date();
  const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timePart = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const autoTitle = `新建项目 ${datePart} ${timePart}`;
  const finalTitle = title?.trim() || autoTitle;

  return {
    id: 'sproj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    title: finalTitle,
    createdAt: Date.now(),
    lastModified: Date.now(),
    visualStyle: '3d-animation',
    language: '中文',
    characterLibrary: [],
    sceneLibrary: [],
    propLibrary: [],
  };
};

// =============================================
// Series CRUD
// =============================================

export const saveSeries = async (s: Series): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SERIES_STORE, 'readwrite');
    tx.objectStore(SERIES_STORE).put({ ...s, lastModified: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const getSeriesByProject = async (projectId: string): Promise<Series[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SERIES_STORE, 'readonly');
    const idx = tx.objectStore(SERIES_STORE).index('projectId');
    const req = idx.getAll(projectId);
    req.onsuccess = () => {
      const items = (req.result as Series[]) || [];
      items.sort((a, b) => a.sortOrder - b.sortOrder);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
};

export const deleteSeries = async (id: string): Promise<void> => {
  const db = await openDB();
  const eps = await getEpisodesBySeries(id);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([SERIES_STORE, EP_STORE], 'readwrite');
    tx.objectStore(SERIES_STORE).delete(id);
    for (const ep of eps) tx.objectStore(EP_STORE).delete(ep.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const createNewSeries = (projectId: string, title: string, sortOrder: number): Series => {
  return {
    id: 'series_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    projectId,
    title,
    sortOrder,
    createdAt: Date.now(),
    lastModified: Date.now(),
  };
};

// =============================================
// Episode CRUD
// =============================================

export const saveEpisode = async (ep: Episode): Promise<void> => {
  const normalized = await normalizeAndPersistEpisodeVideos(ep);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EP_STORE, 'readwrite');
    tx.objectStore(EP_STORE).put({ ...normalized, lastModified: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const loadEpisode = async (id: string): Promise<Episode> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EP_STORE, 'readonly');
    const req = tx.objectStore(EP_STORE).get(id);
    req.onsuccess = () => {
      if (req.result) {
        const normalized = normalizeEpisode(req.result as Episode);
        void (async () => {
          try {
            const { project: migrated, changed } = await migrateProjectVideosToOPFS(normalized);
            const migratedEpisode = migrated as Episode;
            if (changed) {
              void saveEpisode(migratedEpisode).catch(error => {
                console.warn('Persist OPFS migration for episode failed.', error);
              });
            }
            resolve(migratedEpisode);
          } catch (error) {
            console.warn('Episode OPFS migration failed, fallback to original episode data.', error);
            resolve(normalized);
          }
        })();
      } else reject(new Error('Episode not found'));
    };
    req.onerror = () => reject(req.error);
  });
};

export const getEpisodesByProject = async (projectId: string): Promise<Episode[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EP_STORE, 'readonly');
    const idx = tx.objectStore(EP_STORE).index('projectId');
    const req = idx.getAll(projectId);
    req.onsuccess = () => {
      const items = ((req.result as Episode[]) || []).map(normalizeEpisode);
      items.sort((a, b) => a.episodeNumber - b.episodeNumber);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
};

export const getEpisodesBySeries = async (seriesId: string): Promise<Episode[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EP_STORE, 'readonly');
    const idx = tx.objectStore(EP_STORE).index('seriesId');
    const req = idx.getAll(seriesId);
    req.onsuccess = () => {
      const items = ((req.result as Episode[]) || []).map(normalizeEpisode);
      items.sort((a, b) => a.episodeNumber - b.episodeNumber);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
};

export const deleteEpisode = async (id: string): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EP_STORE, 'readwrite');
    tx.objectStore(EP_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const createNewEpisode = (projectId: string, seriesId: string, episodeNumber: number, title?: string): Episode => {
  return {
    id: 'ep_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    projectId,
    seriesId,
    episodeNumber,
    title: title || `第 ${episodeNumber} 集`,
    createdAt: Date.now(),
    lastModified: Date.now(),
    stage: 'script',
    rawScript: '',
    targetDuration: '60s',
    language: '中文',
    visualStyle: '3d-animation',
    shotGenerationModel: 'gpt-5.2',
    scriptData: null,
    shots: [],
    isParsingScript: false,
    renderLogs: [],
    characterRefs: [],
    sceneRefs: [],
    propRefs: [],
    promptTemplateOverrides: undefined,
    scriptGenerationCheckpoint: null,
    imageCanvas: undefined,
    videoCanvas: undefined,
  };
};

// =============================================
// Legacy ProjectState compat (episodes store)
// =============================================

export const saveProjectToDB = async (project: ProjectState): Promise<void> => {
  return saveEpisode(project);
};

export const loadProjectFromDB = async (id: string): Promise<ProjectState> => {
  return loadEpisode(id);
};

export const getAllProjectsMetadata = async (): Promise<ProjectState[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EP_STORE, 'readonly');
    const req = tx.objectStore(EP_STORE).getAll();
    req.onsuccess = () => {
      const eps = ((req.result as ProjectState[]) || []).map(ep => normalizeEpisode(ep as Episode));
      eps.sort((a, b) => b.lastModified - a.lastModified);
      resolve(eps);
    };
    req.onerror = () => reject(req.error);
  });
};

export const deleteProjectFromDB = async (id: string): Promise<void> => {
  return deleteEpisode(id);
};

export const createNewProjectState = (): ProjectState => {
  return createNewEpisode('', '', 1, '未命名项目');
};

// =============================================
// Asset Library Operations (unchanged)
// =============================================

export const saveAssetToLibrary = async (item: AssetLibraryItem): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE_NAME, 'readwrite');
    tx.objectStore(ASSET_STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const getAllAssetLibraryItems = async (): Promise<AssetLibraryItem[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE_NAME, 'readonly');
    const req = tx.objectStore(ASSET_STORE_NAME).getAll();
    req.onsuccess = () => {
      const items = (req.result as AssetLibraryItem[]) || [];
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
};

export const deleteAssetFromLibrary = async (id: string): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE_NAME, 'readwrite');
    tx.objectStore(ASSET_STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

// =============================================
// CanvasGraph CRUD (v4)
// =============================================

export const getCanvasGraph = async (
  episodeId: string,
  mode: 'image' | 'video'
): Promise<CanvasGraphEntity | null> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CANVAS_GRAPH_STORE, 'readonly');
    const store = tx.objectStore(CANVAS_GRAPH_STORE);
    if (store.indexNames.contains('episodeId_mode')) {
      const idx = store.index('episodeId_mode');
      const req = idx.get([episodeId, mode]);
      req.onsuccess = () => resolve((req.result as CanvasGraphEntity) || null);
      req.onerror = () => reject(req.error);
    } else if (store.indexNames.contains('episodeId')) {
      const idx = store.index('episodeId');
      const req = idx.getAll(episodeId);
      req.onsuccess = () => {
        const items = (req.result as CanvasGraphEntity[]) || [];
        const match = items.find(g => g.mode === mode) || null;
        resolve(match);
      };
      req.onerror = () => reject(req.error);
    } else {
      const req = store.getAll();
      req.onsuccess = () => {
        const items = (req.result as CanvasGraphEntity[]) || [];
        const match = items.find(g => g.episodeId === episodeId && g.mode === mode) || null;
        resolve(match);
      };
      req.onerror = () => reject(req.error);
    }
  });
};

export const saveCanvasGraph = async (graph: CanvasGraphEntity): Promise<void> => {
  const db = await openDB();
  const normalized: CanvasGraphEntity = {
    ...graph,
    updatedAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CANVAS_GRAPH_STORE, 'readwrite');
    tx.objectStore(CANVAS_GRAPH_STORE).put(normalized);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const deleteCanvasGraph = async (
  episodeId: string,
  mode: 'image' | 'video'
): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CANVAS_GRAPH_STORE, 'readwrite');
    const store = tx.objectStore(CANVAS_GRAPH_STORE);
    if (store.indexNames.contains('episodeId_mode')) {
      const idx = store.index('episodeId_mode');
      const req = idx.get([episodeId, mode]);
      req.onsuccess = () => {
        const found = req.result as CanvasGraphEntity | undefined;
        if (found && found.id) {
          store.delete(found.id);
        }
      };
      req.onerror = () => reject(req.error);
    } else if (store.indexNames.contains('episodeId')) {
      const idx = store.index('episodeId');
      const req = idx.getAll(episodeId);
      req.onsuccess = () => {
        const items = (req.result as CanvasGraphEntity[]) || [];
        items.filter(g => g.mode === mode).forEach(g => store.delete(g.id));
      };
      req.onerror = () => reject(req.error);
    } else {
      const req = store.getAll();
      req.onsuccess = () => {
        const items = (req.result as CanvasGraphEntity[]) || [];
        items
          .filter(g => g.episodeId === episodeId && g.mode === mode)
          .forEach(g => store.delete(g.id));
      };
      req.onerror = () => reject(req.error);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

// =============================================
// MediaVersion & CommitRecord & Task CRUD (v4)
// =============================================

export const listMediaVersions = async (
  targetType?: string,
  targetId?: string
): Promise<MediaVersionEntity[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_VERSION_STORE, 'readonly');
    const store = tx.objectStore(MEDIA_VERSION_STORE);
    let req: IDBRequest;
    if (targetType && targetId && store.indexNames.contains('targetType_targetId')) {
      const idx = store.index('targetType_targetId');
      req = idx.getAll([targetType, targetId]);
    } else if (targetId && store.indexNames.contains('targetId')) {
      const idx = store.index('targetId');
      req = idx.getAll(targetId);
    } else {
      req = store.getAll();
    }
    req.onsuccess = () => {
      let results = (req.result as MediaVersionEntity[]) || [];
      if (targetType) {
        results = results.filter(v => v.targetType === targetType);
      }
      if (targetId) {
        results = results.filter(v => v.targetId === targetId);
      }
      results.sort((a, b) => a.versionNumber - b.versionNumber);
      resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
};

export const saveMediaVersion = async (version: MediaVersionEntity): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_VERSION_STORE, 'readwrite');
    tx.objectStore(MEDIA_VERSION_STORE).put(version);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const listCommitRecords = async (targetId: string): Promise<CommitRecordEntity[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COMMIT_RECORD_STORE, 'readonly');
    const store = tx.objectStore(COMMIT_RECORD_STORE);
    let req: IDBRequest;
    if (targetId && store.indexNames.contains('targetId')) {
      const idx = store.index('targetId');
      req = idx.getAll(targetId);
    } else {
      req = store.getAll();
    }
    req.onsuccess = () => {
      let results = (req.result as CommitRecordEntity[]) || [];
      if (targetId) {
        results = results.filter(r => r.targetId === targetId);
      }
      results.sort((a, b) => b.timestamp - a.timestamp);
      resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
};

export const saveCommitRecord = async (record: CommitRecordEntity): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COMMIT_RECORD_STORE, 'readwrite');
    tx.objectStore(COMMIT_RECORD_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const listGenerationTasks = async (graphId: string): Promise<GenerationTaskEntity[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GENERATION_TASK_STORE, 'readonly');
    const store = tx.objectStore(GENERATION_TASK_STORE);
    let req: IDBRequest;
    if (graphId && store.indexNames.contains('graphId')) {
      const idx = store.index('graphId');
      req = idx.getAll(graphId);
    } else {
      req = store.getAll();
    }
    req.onsuccess = () => {
      let results = (req.result as GenerationTaskEntity[]) || [];
      if (graphId) {
        results = results.filter(t => t.graphId === graphId);
      }
      results.sort((a, b) => a.createdAt - b.createdAt);
      resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
};

export const saveGenerationTask = async (task: GenerationTaskEntity): Promise<void> => {
  const db = await openDB();
  const normalized: GenerationTaskEntity = {
    ...task,
    updatedAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GENERATION_TASK_STORE, 'readwrite');
    tx.objectStore(GENERATION_TASK_STORE).put(normalized);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const collectTargetIdsFromEpisodes = (episodes: Episode[]): Set<string> => {
  const ids = new Set<string>();
  for (const ep of episodes) {
    if (!ep) continue;
    if (ep.id) ids.add(ep.id);
    (ep.shots || []).forEach(shot => {
      if (shot.id) ids.add(shot.id);
      (shot.keyframes || []).forEach(kf => {
        if (kf.id) ids.add(kf.id);
      });
    });
    (ep.characterRefs || []).forEach(r => ids.add(r.characterId));
    (ep.sceneRefs || []).forEach(r => ids.add(r.sceneId));
    (ep.propRefs || []).forEach(r => ids.add(r.propId));
    if (ep.scriptData) {
      (ep.scriptData.characters || []).forEach(c => {
        if (c.id) ids.add(c.id);
        if (c.libraryId) ids.add(c.libraryId);
      });
      (ep.scriptData.scenes || []).forEach(s => {
        if (s.id) ids.add(s.id);
        if (s.libraryId) ids.add(s.libraryId);
      });
      (ep.scriptData.props || []).forEach(p => {
        if (p.id) ids.add(p.id);
        if (p.libraryId) ids.add(p.libraryId);
      });
    }
  }
  return ids;
};

// =============================================
// Export / Import
// =============================================

export const exportIndexedDBData = async (): Promise<IndexedDBExportPayload> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const storeCandidates = [
      STORE_NAME,
      ASSET_STORE_NAME,
      SP_STORE,
      SERIES_STORE,
      EP_STORE,
      CANVAS_GRAPH_STORE,
      GENERATION_TASK_STORE,
      MEDIA_VERSION_STORE,
      COMMIT_RECORD_STORE,
    ];
    const storeNames = storeCandidates.filter(name => db.objectStoreNames.contains(name));
    const tx = db.transaction(storeNames, 'readonly');
    const projectReq = db.objectStoreNames.contains(STORE_NAME)
      ? tx.objectStore(STORE_NAME).getAll()
      : null;
    const assetReq = tx.objectStore(ASSET_STORE_NAME).getAll();
    const spReq = tx.objectStore(SP_STORE).getAll();
    const seriesReq = tx.objectStore(SERIES_STORE).getAll();
    const epReq = tx.objectStore(EP_STORE).getAll();
    const canvasReq = db.objectStoreNames.contains(CANVAS_GRAPH_STORE)
      ? tx.objectStore(CANVAS_GRAPH_STORE).getAll()
      : null;
    const taskReq = db.objectStoreNames.contains(GENERATION_TASK_STORE)
      ? tx.objectStore(GENERATION_TASK_STORE).getAll()
      : null;
    const mediaReq = db.objectStoreNames.contains(MEDIA_VERSION_STORE)
      ? tx.objectStore(MEDIA_VERSION_STORE).getAll()
      : null;
    const commitReq = db.objectStoreNames.contains(COMMIT_RECORD_STORE)
      ? tx.objectStore(COMMIT_RECORD_STORE).getAll()
      : null;

    tx.oncomplete = () => {
      void (async () => {
        try {
          const episodes = (epReq.result as Episode[]) || [];
          const portableEpisodes = await Promise.all(
            episodes.map(ep => materializeProjectVideosForExport(normalizeEpisode(ep)))
          );

          resolve({
            schemaVersion: EXPORT_SCHEMA_VERSION,
            exportedAt: Date.now(),
            scope: 'all',
            dbName: DB_NAME,
            dbVersion: DB_VERSION,
            stores: {
              projects: (projectReq?.result as ProjectState[]) || [],
              assetLibrary: (assetReq.result as AssetLibraryItem[]) || [],
              seriesProjects: (spReq.result as SeriesProject[]) || [],
              series: (seriesReq.result as Series[]) || [],
              episodes: portableEpisodes as Episode[],
              canvasGraphs: (canvasReq?.result as CanvasGraphEntity[]) || [],
              generationTasks: (taskReq?.result as GenerationTaskEntity[]) || [],
              mediaVersions: (mediaReq?.result as MediaVersionEntity[]) || [],
              commitRecords: (commitReq?.result as CommitRecordEntity[]) || [],
            },
          });
        } catch (error) {
          reject(error);
        }
      })();
    };
    tx.onerror = () => reject(tx.error);
  });
};

export const exportProjectData = async (project: ProjectState): Promise<IndexedDBExportPayload> => {
  const portableProject = await materializeProjectVideosForExport(project);
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const storeCandidates = [
      ASSET_STORE_NAME,
      SP_STORE,
      SERIES_STORE,
      CANVAS_GRAPH_STORE,
      GENERATION_TASK_STORE,
      MEDIA_VERSION_STORE,
      COMMIT_RECORD_STORE,
    ];
    const availableStores = storeCandidates.filter(name => db.objectStoreNames.contains(name));
    if (availableStores.length === 0) {
      resolve({
        schemaVersion: EXPORT_SCHEMA_VERSION,
        exportedAt: Date.now(),
        scope: 'episode',
        dbName: DB_NAME,
        dbVersion: DB_VERSION,
        stores: {
          projects: [portableProject],
          assetLibrary: [],
          seriesProjects: [],
          series: [],
          episodes: [portableProject],
          canvasGraphs: [],
          generationTasks: [],
          mediaVersions: [],
          commitRecords: [],
        },
      });
      return;
    }

    const tx = db.transaction(availableStores, 'readonly');
    const assetReq = db.objectStoreNames.contains(ASSET_STORE_NAME)
      ? tx.objectStore(ASSET_STORE_NAME).getAll()
      : null;
    const spReq = (project.projectId && db.objectStoreNames.contains(SP_STORE))
      ? tx.objectStore(SP_STORE).get(project.projectId)
      : null;
    const seriesReq = (project.seriesId && db.objectStoreNames.contains(SERIES_STORE))
      ? tx.objectStore(SERIES_STORE).get(project.seriesId)
      : null;
    const canvasReq = db.objectStoreNames.contains(CANVAS_GRAPH_STORE)
      ? tx.objectStore(CANVAS_GRAPH_STORE).getAll()
      : null;
    const taskReq = db.objectStoreNames.contains(GENERATION_TASK_STORE)
      ? tx.objectStore(GENERATION_TASK_STORE).getAll()
      : null;
    const mediaReq = db.objectStoreNames.contains(MEDIA_VERSION_STORE)
      ? tx.objectStore(MEDIA_VERSION_STORE).getAll()
      : null;
    const commitReq = db.objectStoreNames.contains(COMMIT_RECORD_STORE)
      ? tx.objectStore(COMMIT_RECORD_STORE).getAll()
      : null;

    tx.oncomplete = () => {
      try {
        const allCanvasGraphs = (canvasReq?.result as CanvasGraphEntity[]) || [];
        const canvasGraphs = allCanvasGraphs.filter(g => g.episodeId === project.id);
        const graphIds = new Set(canvasGraphs.map(g => g.id));

        const allTasks = (taskReq?.result as GenerationTaskEntity[]) || [];
        const generationTasks = allTasks.filter(t => graphIds.has(t.graphId));

        const targetIds = collectTargetIdsFromEpisodes([project]);
        canvasGraphs.forEach(g => {
          (g.nodes || []).forEach(n => {
            if (n.sourceRef?.shotId) targetIds.add(n.sourceRef.shotId);
            if (n.sourceRef?.keyframeId) targetIds.add(n.sourceRef.keyframeId);
            if (n.sourceRef?.intervalId) targetIds.add(n.sourceRef.intervalId);
          });
        });

        const allAssets = (assetReq?.result as AssetLibraryItem[]) || [];
        const matchedAssets = allAssets.filter(item => targetIds.has(item.id));

        const allMedia = (mediaReq?.result as MediaVersionEntity[]) || [];
        const mediaVersions = allMedia.filter(v => targetIds.has(v.targetId));

        const allCommits = (commitReq?.result as CommitRecordEntity[]) || [];
        const commitRecords = allCommits.filter(c => targetIds.has(c.targetId));

        const sp = spReq?.result as SeriesProject | undefined;
        const s = seriesReq?.result as Series | undefined;

        resolve({
          schemaVersion: EXPORT_SCHEMA_VERSION,
          exportedAt: Date.now(),
          scope: 'episode',
          dbName: DB_NAME,
          dbVersion: DB_VERSION,
          stores: {
            projects: [portableProject],
            assetLibrary: matchedAssets,
            seriesProjects: sp ? [sp] : [],
            series: s ? [s] : [],
            episodes: [portableProject],
            canvasGraphs,
            generationTasks,
            mediaVersions,
            commitRecords,
          },
        });
      } catch (err) {
        reject(err);
      }
    };
    tx.onerror = () => reject(tx.error);
  });
};

export const exportSeriesProjectData = async (projectId: string): Promise<IndexedDBExportPayload> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const storeCandidates = [
      STORE_NAME,
      ASSET_STORE_NAME,
      SP_STORE,
      SERIES_STORE,
      EP_STORE,
      CANVAS_GRAPH_STORE,
      GENERATION_TASK_STORE,
      MEDIA_VERSION_STORE,
      COMMIT_RECORD_STORE,
    ];
    const availableStores = storeCandidates.filter(name => db.objectStoreNames.contains(name));
    const tx = db.transaction(availableStores, 'readonly');
    const spReq = tx.objectStore(SP_STORE).get(projectId);
    const seriesReq = tx.objectStore(SERIES_STORE).index('projectId').getAll(projectId);
    const epReq = tx.objectStore(EP_STORE).index('projectId').getAll(projectId);
    const assetReq = db.objectStoreNames.contains(ASSET_STORE_NAME)
      ? tx.objectStore(ASSET_STORE_NAME).getAll()
      : null;
    const canvasReq = db.objectStoreNames.contains(CANVAS_GRAPH_STORE)
      ? tx.objectStore(CANVAS_GRAPH_STORE).getAll()
      : null;
    const taskReq = db.objectStoreNames.contains(GENERATION_TASK_STORE)
      ? tx.objectStore(GENERATION_TASK_STORE).getAll()
      : null;
    const mediaReq = db.objectStoreNames.contains(MEDIA_VERSION_STORE)
      ? tx.objectStore(MEDIA_VERSION_STORE).getAll()
      : null;
    const commitReq = db.objectStoreNames.contains(COMMIT_RECORD_STORE)
      ? tx.objectStore(COMMIT_RECORD_STORE).getAll()
      : null;

    tx.oncomplete = () => {
      void (async () => {
        const seriesProject = spReq.result as SeriesProject | undefined;
        if (!seriesProject) {
          reject(new Error('Project not found'));
          return;
        }

        try {
          const rawEpisodes = ((epReq.result as Episode[]) || []).map(normalizeEpisode);
          const portableEpisodes = await Promise.all(
            rawEpisodes.map(ep => materializeProjectVideosForExport(ep))
          );

          const episodeIds = new Set(rawEpisodes.map(ep => ep.id));
          const allGraphs = (canvasReq?.result as CanvasGraphEntity[]) || [];
          const canvasGraphs = allGraphs.filter(g => episodeIds.has(g.episodeId));

          const graphIds = new Set(canvasGraphs.map(g => g.id));
          const allTasks = (taskReq?.result as GenerationTaskEntity[]) || [];
          const generationTasks = allTasks.filter(t => graphIds.has(t.graphId));

          const targetIds = collectTargetIdsFromEpisodes(rawEpisodes);
          canvasGraphs.forEach(g => {
            (g.nodes || []).forEach(n => {
              if (n.sourceRef?.shotId) targetIds.add(n.sourceRef.shotId);
              if (n.sourceRef?.keyframeId) targetIds.add(n.sourceRef.keyframeId);
              if (n.sourceRef?.intervalId) targetIds.add(n.sourceRef.intervalId);
            });
          });

          const allAssets = (assetReq?.result as AssetLibraryItem[]) || [];
          const matchedAssets = allAssets.filter(item => targetIds.has(item.id));

          const allMedia = (mediaReq?.result as MediaVersionEntity[]) || [];
          const mediaVersions = allMedia.filter(v => targetIds.has(v.targetId));

          const allCommits = (commitReq?.result as CommitRecordEntity[]) || [];
          const commitRecords = allCommits.filter(c => targetIds.has(c.targetId));

          resolve({
            schemaVersion: EXPORT_SCHEMA_VERSION,
            exportedAt: Date.now(),
            scope: 'project',
            dbName: DB_NAME,
            dbVersion: DB_VERSION,
            stores: {
              projects: [],
              assetLibrary: matchedAssets,
              seriesProjects: [seriesProject],
              series: (seriesReq.result as Series[]) || [],
              episodes: portableEpisodes as Episode[],
              canvasGraphs,
              generationTasks,
              mediaVersions,
              commitRecords,
            },
          });
        } catch (error) {
          reject(error);
        }
      })();
    };
    tx.onerror = () => reject(tx.error);
  });
};

const isValidExportPayload = (data: unknown): data is IndexedDBExportPayload => {
  const p = data as IndexedDBExportPayload;
  return !!(p && p.stores);
};

export const importIndexedDBData = async (
  payload: unknown,
  options?: { mode?: 'merge' | 'replace' }
): Promise<{ projects: number; assets: number }> => {
  if (!isValidExportPayload(payload)) throw new Error('导入文件格式不正确');

  const mode = options?.mode || 'merge';
  const db = await openDB();
  const importedEpisodes = await Promise.all(
    ((payload.stores.episodes || []) as Episode[]).map(async (ep) => {
      try {
        return await normalizeAndPersistEpisodeVideos(ep);
      } catch (error) {
        console.warn('Failed to normalize imported episode video storage. Keep original payload.', error);
        return normalizeEpisode(ep);
      }
    })
  );

  const storeCandidates = [
    STORE_NAME,
    ASSET_STORE_NAME,
    SP_STORE,
    SERIES_STORE,
    EP_STORE,
    CANVAS_GRAPH_STORE,
    GENERATION_TASK_STORE,
    MEDIA_VERSION_STORE,
    COMMIT_RECORD_STORE,
  ];
  const storeNames = storeCandidates.filter(name => db.objectStoreNames.contains(name));

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, 'readwrite');

    if (mode === 'replace') {
      storeNames.forEach(s => tx.objectStore(s).clear());
    }

    let count = 0;
    const assetStore = db.objectStoreNames.contains(ASSET_STORE_NAME)
      ? tx.objectStore(ASSET_STORE_NAME)
      : null;
    if (assetStore) {
      (payload.stores.assetLibrary || []).forEach((item: AssetLibraryItem) => {
        assetStore.put(item);
        count++;
      });
    }

    const spStore = db.objectStoreNames.contains(SP_STORE)
      ? tx.objectStore(SP_STORE)
      : null;
    if (spStore) {
      (payload.stores.seriesProjects || []).forEach((sp: SeriesProject) => { spStore.put(sp); count++; });
    }

    const seriesStr = db.objectStoreNames.contains(SERIES_STORE)
      ? tx.objectStore(SERIES_STORE)
      : null;
    if (seriesStr) {
      (payload.stores.series || []).forEach((s: Series) => { seriesStr.put(s); count++; });
    }

    const epStore = db.objectStoreNames.contains(EP_STORE)
      ? tx.objectStore(EP_STORE)
      : null;
    if (epStore) {
      importedEpisodes.forEach((ep: Episode) => { epStore.put(ep); count++; });
    }

    const convertedLegacyEpisodes: Episode[] = [];

    if (payload.stores.projects && payload.stores.projects.length > 0 && !(payload.stores.episodes && payload.stores.episodes.length > 0)) {
      payload.stores.projects.forEach((p: any) => {
        if (p.shots) {
          p.shots.forEach((s: any) => {
            if (s.videoModel === 'veo-r2v' || s.videoModel === 'veo') {
              s.videoModel = 'veo_3_1-fast';
            }
          });
        }
        if (!p.renderLogs) p.renderLogs = [];
        if (p.scriptData && !p.scriptData.props) p.scriptData.props = [];

        const genId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const projectId = genId('sproj');
        const seriesId = genId('series');
        const episodeId = genId('ep');

        const chars = p.scriptData?.characters || [];
        const scenes = p.scriptData?.scenes || [];
        const props = p.scriptData?.props || [];
        const episodeScenes = scenes.map((s: any) => ({ ...s, libraryId: s.id, libraryVersion: 1 }));
        const episodeProps = props.map((pr: any) => ({ ...pr, libraryId: pr.id, libraryVersion: 1 }));

        const sp: SeriesProject = {
          id: projectId, title: p.title, createdAt: p.createdAt || Date.now(), lastModified: p.lastModified || Date.now(),
          visualStyle: p.visualStyle || '3d-animation', language: p.language || '中文',
          artDirection: p.scriptData?.artDirection,
          characterLibrary: chars.map((c: any) => ({ ...c, version: 1 })),
          sceneLibrary: scenes.map((s: any) => ({ ...s, version: 1 })),
          propLibrary: props.map((pr: any) => ({ ...pr, version: 1 })),
        };
        if (spStore) spStore.put(sp);

        const s: Series = { id: seriesId, projectId, title: '第一季', sortOrder: 0, createdAt: Date.now(), lastModified: Date.now() };
        if (seriesStr) seriesStr.put(s);

        const ep: Episode = {
          id: episodeId, projectId, seriesId, episodeNumber: 1,
          title: `第 1 集`,
          createdAt: p.createdAt || Date.now(), lastModified: p.lastModified || Date.now(),
          stage: p.stage || 'script', rawScript: p.rawScript || '', targetDuration: p.targetDuration || '60s',
          language: p.language || '中文', visualStyle: p.visualStyle || '3d-animation',
          shotGenerationModel: normalizeChatModelId(p.shotGenerationModel) || 'gpt-5.2',
          scriptData: p.scriptData
            ? {
                ...p.scriptData,
                characters: chars.map((c: any) => ({ ...c, libraryId: c.id, libraryVersion: 1 })),
                scenes: episodeScenes,
                props: episodeProps,
              }
            : null,
          shots: p.shots || [], isParsingScript: false, renderLogs: p.renderLogs || [],
          characterRefs: chars.map((c: any) => ({ characterId: c.id, syncedVersion: 1, syncStatus: 'synced' as const })),
          sceneRefs: scenes.map((s: any) => ({ sceneId: s.id, syncedVersion: 1, syncStatus: 'synced' as const })),
          propRefs: props.map((pr: any) => ({ propId: pr.id, syncedVersion: 1, syncStatus: 'synced' as const })),
          promptTemplateOverrides: sanitizePromptTemplateOverrides(p.promptTemplateOverrides),
          scriptGenerationCheckpoint: null,
          imageCanvas: p.imageCanvas,
          videoCanvas: p.videoCanvas,
        };
        const normalizedEp = normalizeEpisode(ep);
        if (epStore) epStore.put(normalizedEp);
        convertedLegacyEpisodes.push(normalizedEp);
        count += 3;
      });
    }

    const canvasStore = db.objectStoreNames.contains(CANVAS_GRAPH_STORE)
      ? tx.objectStore(CANVAS_GRAPH_STORE)
      : null;
    const taskStore = db.objectStoreNames.contains(GENERATION_TASK_STORE)
      ? tx.objectStore(GENERATION_TASK_STORE)
      : null;
    const mediaStore = db.objectStoreNames.contains(MEDIA_VERSION_STORE)
      ? tx.objectStore(MEDIA_VERSION_STORE)
      : null;
    const commitStore = db.objectStoreNames.contains(COMMIT_RECORD_STORE)
      ? tx.objectStore(COMMIT_RECORD_STORE)
      : null;

    // 导入新数组 (存在才导入)
    if (canvasStore && Array.isArray(payload.stores.canvasGraphs) && payload.stores.canvasGraphs.length > 0) {
      payload.stores.canvasGraphs.forEach((g: CanvasGraphEntity) => canvasStore.put(g));
    }
    if (taskStore && Array.isArray(payload.stores.generationTasks) && payload.stores.generationTasks.length > 0) {
      payload.stores.generationTasks.forEach((t: GenerationTaskEntity) => taskStore.put(t));
    }
    if (mediaStore && Array.isArray(payload.stores.mediaVersions) && payload.stores.mediaVersions.length > 0) {
      payload.stores.mediaVersions.forEach((v: MediaVersionEntity) => mediaStore.put(v));
    }
    if (commitStore && Array.isArray(payload.stores.commitRecords) && payload.stores.commitRecords.length > 0) {
      payload.stores.commitRecords.forEach((c: CommitRecordEntity) => commitStore.put(c));
    }

    // 若为旧 v2/v3 包 (无新 canvasGraphs 数组，episodes 带 imageCanvas/videoCanvas 或媒体)，自动就地生成基线
    const isLegacyPackage = (payload.schemaVersion || 0) < 4 || !Array.isArray(payload.stores.canvasGraphs);
    if (isLegacyPackage && (canvasStore || mediaStore)) {
      const allEpisodes = [...importedEpisodes, ...convertedLegacyEpisodes];
      const { canvasGraphs, mediaVersions } = generateV4BaselineFromEpisodes(allEpisodes);
      if (canvasStore) {
        canvasGraphs.forEach(g => canvasStore.put(g));
      }
      if (mediaStore && (!Array.isArray(payload.stores.mediaVersions) || payload.stores.mediaVersions.length === 0)) {
        mediaVersions.forEach(v => mediaStore.put(v));
      }
    }

    tx.oncomplete = () => resolve({ projects: count, assets: (payload.stores.assetLibrary || []).length });
    tx.onerror = () => reject(tx.error);
  });
};

// =============================================
// Utilities
// =============================================

export const convertImageToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('只支持图片文件')); return; }
    if (file.size > 10 * 1024 * 1024) { reject(new Error('图片大小不能超过 10MB')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
};
