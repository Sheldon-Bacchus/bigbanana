import JSZip from 'jszip';
import {
  Episode,
  MediaVersionEntity,
  ProjectState,
} from '../types';
import {
  loadEpisode,
  loadProjectFromDB,
  exportProjectData,
  importIndexedDBData,
  IndexedDBExportPayload,
} from './storageService';
import {
  isOpfsVideoRef,
  isVideoDataUrl,
  resolveVideoToBlob,
  persistVideoReference,
  persistVideoBlobToOPFS,
  supportsOPFSVideoStorage,
} from './videoStorageService';

export interface PortableArchiveExportResult {
  blob: Blob;
  fileName: string;
  mediaCount: number;
}

export interface PortableArchiveImportResult {
  projects: number;
  assets: number;
  mediaRestored: number;
}

/**
 * 将指定分集连同关联的 OPFS 媒体资源打包为便携式归档 ZIP (T25)。
 *
 * 特性：
 * 1. 结构为 project.json + media/*。
 * 2. 视频资源以二进制 Blob 直接写入 ZIP，绝不进行 Base64 膨胀。
 * 3. project.json 中所有媒体引用均改写为相对路径并记录 mediaMapping。
 * 4. 复用 storageService.exportProjectData 获取完整 v4 Stores 结构。
 */
export async function exportEpisodeAsPortableZip(
  episodeId: string
): Promise<PortableArchiveExportResult> {
  if (!episodeId) {
    throw new Error('Episode ID is required for portable export (导出便携包必须提供 episodeId)');
  }

  // 1. 获取目标分集数据
  let episode: Episode | null = null;
  try {
    episode = await loadEpisode(episodeId);
  } catch {
    try {
      episode = await loadProjectFromDB(episodeId);
    } catch {
      episode = null;
    }
  }

  if (!episode) {
    throw new Error(`Episode not found: ${episodeId} (未找到指定分集)`);
  }

  // 2. 初始化 JSZip 容器
  const zip = new JSZip();
  const mediaFolder = zip.folder('media');
  if (!mediaFolder) {
    throw new Error('Failed to create media directory in zip container');
  }

  // 3. 追踪原始引用与包内相对路径的映射关系
  const originalToZipPathMap = new Map<string, string>();
  const zipPathToOriginalMap: Record<string, string> = {};
  let mediaSequence = 0;

  /**
   * 辅助提取媒体并写入 zip/media 目录
   */
  const archiveMediaRef = async (ref: string, filePrefix: string): Promise<string> => {
    if (!ref) return ref;

    // 若此前已打包相同引用，直接复用路径
    if (originalToZipPathMap.has(ref)) {
      return originalToZipPathMap.get(ref)!;
    }

    // 仅针对 OPFS 引用、Data URL 或远程媒体进行二进制转存
    const isOpfs = isOpfsVideoRef(ref);
    const isData = isVideoDataUrl(ref);
    const isRemote = /^https?:\/\//i.test(ref);

    if (!isOpfs && !isData && !isRemote) {
      return ref;
    }

    try {
      const blob = await resolveVideoToBlob(ref);
      mediaSequence++;
      const extension = blob.type.includes('webm') ? 'webm' : 'mp4';
      const fileName = `${filePrefix}_${String(mediaSequence).padStart(3, '0')}.${extension}`;
      const relativePath = `media/${fileName}`;

      // 以原始二进制流形式写入 ZIP，杜绝 Base64 膨胀 (兼顾 Browser Blob 与 ArrayBuffer)
      const binaryContent = typeof blob.arrayBuffer === 'function' ? await blob.arrayBuffer() : blob;
      mediaFolder.file(fileName, binaryContent);

      originalToZipPathMap.set(ref, relativePath);
      zipPathToOriginalMap[relativePath] = ref;
      return relativePath;
    } catch (err) {
      const message = `Failed to resolve and archive media "${ref}": ${String((err as Error)?.message || err)}`;
      console.warn('[portableArchiveService]', message);
      throw new Error(message);
    }
  };

  // 4. 为避免 exportProjectData 触发内部 materializeProjectVideosForExport 生成 Base64，
  // 构造临时安全副本阻断 Base64 化，保持导出性能
  const originalShots = episode.shots || [];
  const safeShots = originalShots.map(shot => ({
    ...shot,
    interval: shot.interval ? { ...shot.interval, videoUrl: '' } : undefined,
  }));
  const safeEpisode: Episode = {
    ...episode,
    shots: safeShots,
  };

  // 5. 复用 exportProjectData 取得包含关联 stores (canvasGraphs, mediaVersions 等) 的基础 payload
  const basePayload = await exportProjectData(safeEpisode);

  // 6. 遍历原始分镜，读取真实视频二进制并改写为相对路径
  const rewrittenShots = await Promise.all(
    originalShots.map(async (shot, index) => {
      const rawUrl = shot.interval?.videoUrl;
      if (!rawUrl) return shot;

      const zipPath = await archiveMediaRef(rawUrl, `shot_${index + 1}`);
      return {
        ...shot,
        interval: {
          ...shot.interval,
          videoUrl: zipPath,
        },
      };
    })
  );

  // 7. 处理 mediaVersions 中的视频存储引用
  const rewrittenMediaVersions: MediaVersionEntity[] = [];
  if (Array.isArray(basePayload.stores.mediaVersions)) {
    for (const mver of basePayload.stores.mediaVersions) {
      if (mver.mediaType === 'video' && mver.storageRef) {
        const zipPath = await archiveMediaRef(mver.storageRef, `mver_${mver.id.slice(-6)}`);
        rewrittenMediaVersions.push({
          ...mver,
          storageRef: zipPath,
        });
      } else {
        rewrittenMediaVersions.push(mver);
      }
    }
  }

  // 8. 组装最终写入 project.json 的数据模型
  const finalEpisode: Episode = {
    ...episode,
    shots: rewrittenShots,
  };

  const finalPayload: IndexedDBExportPayload & { mediaMapping?: Record<string, string> } = {
    ...basePayload,
    stores: {
      ...basePayload.stores,
      projects: [finalEpisode],
      episodes: [finalEpisode],
      mediaVersions: rewrittenMediaVersions,
    },
    mediaMapping: zipPathToOriginalMap,
  };

  // 9. 将 project.json 写入 ZIP 根路径
  zip.file('project.json', JSON.stringify(finalPayload, null, 2));

  // 10. 生成 ZIP Blob 产物
  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const safeTitle = (episode.title || episode.id || 'episode')
    .replace(/[^\w\u4e00-\u9fa5_-]/g, '_')
    .slice(0, 32);
  const fileName = `${safeTitle}_portable.zip`;

  return {
    blob: zipBlob,
    fileName,
    mediaCount: originalToZipPathMap.size,
  };
}

/**
 * 导入便携式归档 ZIP (T25)。
 *
 * 特性：
 * 1. 解压 project.json 与 media/*。
 * 2. 经由 videoStorageService 写回本地 OPFS。
 * 3. 失败项完整收集不静默，有失败即抛出明确错误。
 * 4. 路径映射还原后调用 storageService.importIndexedDBData(payload, { mode: 'merge' })。
 */
export async function importPortableZip(
  file: File | Blob
): Promise<PortableArchiveImportResult> {
  if (!file) {
    throw new Error('No zip file provided for portable import (未提供待导入的 ZIP 文件)');
  }

  // 1. 读取并解压 ZIP 文件
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (err) {
    throw new Error(`Failed to read ZIP archive: ${String((err as Error)?.message || err)}`);
  }

  // 2. 读取并解析 project.json
  const projectFile = zip.file('project.json');
  if (!projectFile) {
    throw new Error('便携包格式错误: 缺少 project.json 描述文件');
  }

  let payload: IndexedDBExportPayload & { mediaMapping?: Record<string, string> };
  try {
    const jsonContent = await projectFile.async('text');
    payload = JSON.parse(jsonContent);
  } catch (err) {
    throw new Error(`便携包 project.json 解析失败: ${String((err as Error)?.message || err)}`);
  }

  if (!payload || !payload.stores) {
    throw new Error('便携包数据格式错误: 缺少 stores 数据结构');
  }

  // 3. 收集 ZIP 中的 media/* 文件
  const mediaEntries: { zipPath: string; entry: JSZip.JSZipObject }[] = [];
  zip.forEach((relativePath, entry) => {
    if (!entry.dir && (relativePath.startsWith('media/') || !relativePath.endsWith('.json'))) {
      mediaEntries.push({ zipPath: relativePath, entry });
    }
  });

  // 4. 将媒体文件逐个写回本地 OPFS，收集失败项不静默
  const zipPathToOpfsMap = new Map<string, string>();
  const failureList: { path: string; error: string }[] = [];
  let mediaRestored = 0;

  for (const { zipPath, entry } of mediaEntries) {
    try {
      const blob = await entry.async('blob');
      let opfsRef: string;

      if (supportsOPFSVideoStorage()) {
        try {
          opfsRef = await persistVideoBlobToOPFS(blob, {
            episodeId: payload.stores.episodes?.[0]?.id,
          });
        } catch {
          // 降级使用 persistVideoReference
          if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            const tempObjectUrl = URL.createObjectURL(blob);
            opfsRef = await persistVideoReference(tempObjectUrl, {
              episodeId: payload.stores.episodes?.[0]?.id,
            });
          } else {
            throw new Error('Unable to persist video blob: URL.createObjectURL is unavailable');
          }
        }
      } else {
        // 环境不支持 OPFS 时的安全兜底 (如部分单测与无沙盒环境)
        if (typeof FileReader !== 'undefined') {
          opfsRef = await new Promise<string>((res, rej) => {
            const reader = new FileReader();
            reader.onloadend = () => res(reader.result as string);
            reader.onerror = () => rej(reader.error);
            reader.readAsDataURL(blob);
          });
        } else {
          opfsRef = zipPath;
        }
      }

      zipPathToOpfsMap.set(zipPath, opfsRef);
      mediaRestored++;
    } catch (err) {
      failureList.push({
        path: zipPath,
        error: String((err as Error)?.message || err),
      });
    }
  }

  // 存在任何失败项均不静默，汇总报错
  if (failureList.length > 0) {
    const errorDetails = failureList.map(f => `${f.path}: ${f.error}`).join('; ');
    throw new Error(`便携包恢复媒体失败 (${failureList.length} 项): ${errorDetails}`);
  }

  // 5. 将 payload 中的相对路径映射回写回本地后的 OPFS 引用
  const resolveRef = (val?: string): string => {
    if (!val) return '';
    if (zipPathToOpfsMap.has(val)) {
      return zipPathToOpfsMap.get(val)!;
    }
    const cleanPath = val.replace(/^\.\//, '');
    if (zipPathToOpfsMap.has(cleanPath)) {
      return zipPathToOpfsMap.get(cleanPath)!;
    }
    return val;
  };

  // 改写 episodes 中的视频引用
  if (Array.isArray(payload.stores.episodes)) {
    payload.stores.episodes.forEach(ep => {
      (ep.shots || []).forEach(shot => {
        if (shot.interval?.videoUrl) {
          shot.interval.videoUrl = resolveRef(shot.interval.videoUrl);
        }
      });
    });
  }

  // 改写 projects 中的视频引用
  if (Array.isArray(payload.stores.projects)) {
    payload.stores.projects.forEach(p => {
      (p.shots || []).forEach(shot => {
        if (shot.interval?.videoUrl) {
          shot.interval.videoUrl = resolveRef(shot.interval.videoUrl);
        }
      });
    });
  }

  // 改写 mediaVersions 中的存储引用
  if (Array.isArray(payload.stores.mediaVersions)) {
    payload.stores.mediaVersions.forEach(v => {
      if (v.storageRef) {
        v.storageRef = resolveRef(v.storageRef);
      }
    });
  }

  // 6. 调用 storageService.importIndexedDBData(payload, { mode: 'merge' })
  const result = await importIndexedDBData(payload, { mode: 'merge' });

  return {
    projects: result.projects,
    assets: result.assets,
    mediaRestored,
  };
}
