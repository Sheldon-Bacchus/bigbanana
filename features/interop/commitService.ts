import { MediaVersionEntity, CommitRecordEntity } from '../../types';
import {
  saveMediaVersion,
  listMediaVersions,
  commitMediaVersionAtomic,
  rollbackMediaVersionAtomic,
  listCommitRecords,
} from '../../services/storageService';

/**
 * 过期写回错误（当目标槽位媒体已被修改时强阻断）
 */
export class StaleCommitError extends Error {
  constructor(
    message: string,
    public expectedRef?: string,
    public currentRef?: string
  ) {
    super(message);
    this.name = 'StaleCommitError';
  }
}

/**
 * 单项写回参数定义
 */
export interface CommitArtifactParams {
  episodeId: string;
  targetType: 'keyframe' | 'interval';
  targetId: string; // 关键帧 ID (如 kf-xxx) 或 分镜 ID (如 shot-xxx)
  mediaType: 'image' | 'video';
  storageRef: string; // Base64 或 OPFS 路径引用
  sourceNodeId: string;
  expectedCurrentRef?: string; // 乐观锁：当前槽位预期媒体引用
  promptSnapshot?: string;
  modelSnapshot?: string;
  taskId?: string;
}

/**
 * 单项写回返回结果
 */
export interface CommitArtifactResult {
  version: MediaVersionEntity;
  record: CommitRecordEntity;
}

/**
 * 回滚操作返回结果
 */
export interface RollbackResult {
  targetType: string;
  targetId: string;
  storageRef: string;
}

/**
 * 批量写回项与结果接口
 */
export interface BatchCommitItem {
  params: CommitArtifactParams;
  shotTitle?: string;
}

export interface BatchCommitItemResult {
  item: BatchCommitItem;
  success: boolean;
  result?: CommitArtifactResult;
  error?: string;
}

/**
 * 生成符合项目规范的稳定唯一 ID
 */
const generateId = (prefix: string): string => {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
};

/**
 * T21/T23: 将画布产物安全写回导演台对应槽位
 * - 过期检测：expectedCurrentRef 与当前槽位媒体不一致时抛 StaleCommitError（不得静默覆盖）
 * - 版本栈：versionNumber = max + 1，旧版本 isCurrent=false，新版本 isCurrent=true
 * - 审计记录：写入 CommitRecord（status 'applied', diffSummary.mediaReplaced=true）
 */
export const commitArtifact = async (
  params: CommitArtifactParams
): Promise<CommitArtifactResult> => {
  const {
    episodeId,
    targetType,
    targetId,
    mediaType,
    storageRef,
    sourceNodeId,
    expectedCurrentRef,
    promptSnapshot,
    modelSnapshot,
    taskId,
  } = params;

  // 1. 查询目标槽位的全量现有版本栈
  const existingVersions = await listMediaVersions(targetType, targetId);

  // 2. 找到当前活跃版本（若有）
  const currentActive =
    existingVersions.find((v) => v.isCurrent) ||
    (existingVersions.length > 0 ? existingVersions[existingVersions.length - 1] : undefined);

  // 3. 过期检测（Stale Guard 乐观锁检查）
  // 当指定了 expectedCurrentRef 时，必须与现有活跃版本的 storageRef 严格一致；如果不一致说明有并发更新
  if (expectedCurrentRef !== undefined) {
    const activeRef = currentActive?.storageRef || '';
    if (currentActive && activeRef !== expectedCurrentRef) {
      throw new StaleCommitError(
        `目标槽位内容已被修改（当前活跃引用: ${activeRef.slice(0, 32)}...，预期引用: ${expectedCurrentRef.slice(0, 32)}...），拒绝静默覆盖。`,
        expectedCurrentRef,
        activeRef
      );
    }
  }

  // 4. 计算版本号：versionNumber = max + 1
  let maxVersion = existingVersions.reduce(
    (max, v) => Math.max(max, v.versionNumber || 0),
    0
  );
  let previousVersionId = currentActive?.id;

  // 若数据库中尚未为该槽位建立版本栈（如初始导入工程），且当前槽位存在旧媒体，先存入基线版本 v1
  if (existingVersions.length === 0 && expectedCurrentRef && expectedCurrentRef.trim()) {
    const baselineVersion: MediaVersionEntity = {
      id: generateId('mver-baseline'),
      targetType,
      targetId,
      versionNumber: 1,
      mediaType,
      storageRef: expectedCurrentRef,
      provenance: {
        source: 'workbench_manual',
      },
      isCurrent: false,
      createdAt: Date.now() - 1000,
    };
    await saveMediaVersion(baselineVersion);
    maxVersion = 1;
    previousVersionId = baselineVersion.id;
  }

  // 5. 同一事务内完成：旧活跃版本翻转 + 新版本插入 + CommitRecord（避免“无当前版本”中间态）
  const nextVersionNumber = maxVersion + 1;
  const newVersionId = generateId('mver');
  const newVersion: MediaVersionEntity = {
    id: newVersionId,
    targetType,
    targetId,
    versionNumber: nextVersionNumber,
    mediaType,
    storageRef,
    provenance: {
      source: 'canvas_commit',
      canvasNodeId: sourceNodeId,
      taskId,
      promptSnapshot,
      modelSnapshot,
    },
    isCurrent: true,
    createdAt: Date.now(),
  };

  const recordId = generateId('cmt');
  const record: CommitRecordEntity = {
    id: recordId,
    sourceNodeId,
    targetId,
    targetType,
    committedVersionId: newVersionId,
    previousVersionId,
    diffSummary: {
      promptChanged: Boolean(promptSnapshot),
      mediaReplaced: true,
    },
    status: 'applied',
    timestamp: Date.now(),
  };
  await commitMediaVersionAtomic(newVersion, record);

  return {
    version: newVersion,
    record,
  };
};

/**
 * T22: 回滚至指定历史版本
 * - 目标版本 isCurrent=true，同目标其余版本 isCurrent=false
 * - 不物理删除任何文件与记录
 * - 返回目标类型、ID 与媒体存储引用供上层更新分镜槽位
 */
export const rollbackToVersion = async (versionId: string): Promise<RollbackResult> => {
  // 1. 获取全局版本列表定位目标
  const allVersions = await listMediaVersions();
  const targetVersion = allVersions.find((v) => v.id === versionId);
  if (!targetVersion) {
    throw new Error(`未找到目标版本: ${versionId}`);
  }

  // 2+3+4. 同一事务内翻转该槽位 isCurrent 并写入回滚审计记录（不物理删除）
  const rollbackRecordId = generateId('cmt-rollback');
  const record: CommitRecordEntity = {
    id: rollbackRecordId,
    sourceNodeId: `rollback-action-${versionId}`,
    targetId: targetVersion.targetId,
    targetType: targetVersion.targetType,
    committedVersionId: targetVersion.id,
    diffSummary: {
      promptChanged: false,
      mediaReplaced: true,
    },
    status: 'reverted',
    timestamp: Date.now(),
  };
  await rollbackMediaVersionAtomic(
    targetVersion.targetType,
    targetVersion.targetId,
    versionId,
    record
  );

  return {
    targetType: targetVersion.targetType,
    targetId: targetVersion.targetId,
    storageRef: targetVersion.storageRef,
  };
};

/**
 * 查询指定槽位的历史版本栈（按版本号倒序排列）
 */
export const listHistory = async (
  targetType?: string,
  targetId?: string
): Promise<MediaVersionEntity[]> => {
  const versions = await listMediaVersions(targetType, targetId);
  return [...versions].sort((a, b) => b.versionNumber - a.versionNumber);
};

/**
 * 查询指定槽位的提交记录（按时间戳倒序排列）
 */
export const listHistoryRecords = async (targetId: string): Promise<CommitRecordEntity[]> => {
  return listCommitRecords(targetId);
};

/**
 * T23: 批量写回操作（支持逐项执行与错误隔离）
 */
export const batchCommitArtifacts = async (
  items: BatchCommitItem[],
  onProgress?: (index: number, total: number, result: BatchCommitItemResult) => void
): Promise<BatchCommitItemResult[]> => {
  const results: BatchCommitItemResult[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const res = await commitArtifact(item.params);
      const successResult: BatchCommitItemResult = {
        item,
        success: true,
        result: res,
      };
      results.push(successResult);
      onProgress?.(i + 1, items.length, successResult);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failResult: BatchCommitItemResult = {
        item,
        success: false,
        error: errorMsg,
      };
      results.push(failResult);
      onProgress?.(i + 1, items.length, failResult);
    }
  }

  return results;
};
