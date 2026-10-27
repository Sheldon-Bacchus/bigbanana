import React, { useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  Clock,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';
import { useProjectContext } from '../../contexts/ProjectContext';
import {
  commitArtifact,
  batchCommitArtifacts,
  StaleCommitError,
  BatchCommitItem,
  BatchCommitItemResult,
} from './commitService';

export interface CommitDialogTarget {
  episodeId: string;
  shotId: string;
  targetType: 'keyframe' | 'interval';
  targetId: string;
  mediaType: 'image' | 'video';
  candidateRef: string;
  currentRef?: string;
  sourceNodeId: string;
  shotTitle?: string;
  promptSnapshot?: string;
}

export interface CommitDialogProps {
  isOpen: boolean;
  onClose: () => void;
  items: CommitDialogTarget[];
  onSuccess?: () => void;
}

export const CommitDialog: React.FC<CommitDialogProps> = ({
  isOpen,
  onClose,
  items,
  onSuccess,
}) => {
  const { updateEpisode } = useProjectContext();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [staleError, setStaleError] = useState<StaleCommitError | null>(null);
  const [forceOverwrite, setForceOverwrite] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  // 批量模式状态追踪
  const [batchProgress, setBatchProgress] = useState<{
    total: number;
    completed: number;
    results: BatchCommitItemResult[];
  } | null>(null);

  if (!isOpen || items.length === 0) return null;

  const isBatch = items.length > 1;
  const singleItem = items[0];

  /**
   * 应用媒体更新到分镜实体（通过 useProjectContext 的 updateEpisode）
   */
  const applyMediaToEpisode = (committedTargets: CommitDialogTarget[]) => {
    updateEpisode((prev) => {
      const targetMap = new Map<string, CommitDialogTarget>();
      committedTargets.forEach((t) => {
        targetMap.set(`${t.shotId}:::${t.targetType}`, t);
      });

      return {
        ...prev,
        shots: (prev.shots || []).map((shot) => {
          let updatedShot = { ...shot };

          const imgTarget = targetMap.get(`${shot.id}:::keyframe`);
          if (imgTarget) {
            const keyframes = (updatedShot.keyframes || []).map((kf) => {
              if (kf.id === imgTarget.targetId || kf.type === 'start') {
                return {
                  ...kf,
                  imageUrl: imgTarget.candidateRef,
                  status: 'completed' as const,
                };
              }
              return kf;
            });
            updatedShot = { ...updatedShot, keyframes };
          }

          const vidTarget = targetMap.get(`${shot.id}:::interval`);
          if (vidTarget) {
            const interval = updatedShot.interval
              ? {
                  ...updatedShot.interval,
                  videoUrl: vidTarget.candidateRef,
                  status: 'completed' as const,
                }
              : {
                  id: `interval-${shot.id}`,
                  startKeyframeId: updatedShot.keyframes?.[0]?.id || '',
                  endKeyframeId: updatedShot.keyframes?.[1]?.id || '',
                  duration: 5,
                  motionStrength: 0.5,
                  videoUrl: vidTarget.candidateRef,
                  status: 'completed' as const,
                };
            updatedShot = { ...updatedShot, interval };
          }

          return updatedShot;
        }),
      };
    });
  };

  /**
   * 单项写回执行
   */
  const handleSingleCommit = async (force: boolean = false) => {
    setIsSubmitting(true);
    setStaleError(null);
    setGeneralError(null);

    try {
      await commitArtifact({
        episodeId: singleItem.episodeId,
        targetType: singleItem.targetType,
        targetId: singleItem.targetId,
        mediaType: singleItem.mediaType,
        storageRef: singleItem.candidateRef,
        sourceNodeId: singleItem.sourceNodeId,
        expectedCurrentRef: force ? undefined : singleItem.currentRef,
        promptSnapshot: singleItem.promptSnapshot,
      });

      // 写回成功后更新分镜状态并触发持久化
      applyMediaToEpisode([singleItem]);
      onSuccess?.();
      onClose();
    } catch (err: unknown) {
      if (err instanceof StaleCommitError) {
        setStaleError(err);
      } else {
        setGeneralError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * 批量写回执行
   */
  const handleBatchCommit = async () => {
    setIsSubmitting(true);
    setGeneralError(null);

    const batchItems: BatchCommitItem[] = items.map((target) => ({
      params: {
        episodeId: target.episodeId,
        targetType: target.targetType,
        targetId: target.targetId,
        mediaType: target.mediaType,
        storageRef: target.candidateRef,
        sourceNodeId: target.sourceNodeId,
        expectedCurrentRef: target.currentRef,
        promptSnapshot: target.promptSnapshot,
      },
      shotTitle: target.shotTitle,
    }));

    setBatchProgress({
      total: batchItems.length,
      completed: 0,
      results: [],
    });

    const results = await batchCommitArtifacts(
      batchItems,
      (current, total, result) => {
        setBatchProgress((prev) => ({
          total,
          completed: current,
          results: [...(prev?.results || []), result],
        }));
      }
    );

    // 将所有成功的项更新入分镜槽位
    const successfulTargets: CommitDialogTarget[] = [];
    results.forEach((r, idx) => {
      if (r.success) {
        successfulTargets.push(items[idx]);
      }
    });

    if (successfulTargets.length > 0) {
      applyMediaToEpisode(successfulTargets);
    }

    setIsSubmitting(false);
    onSuccess?.();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 backdrop-blur-sm animate-in fade-in duration-150 p-4 select-none">
      <div className="relative flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-elevated)] shadow-2xl overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-[var(--border-primary)] px-6 py-4 bg-[var(--bg-surface)]">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent-bg)] border border-[var(--accent-border)] text-[var(--accent-text)]">
              <Upload className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-[var(--text-primary)]">
                {isBatch ? `批量写回导演台 (${items.length} 个镜头产物)` : '写回导演台确认'}
              </h3>
              <p className="text-[11px] text-[var(--text-muted)]">
                {isBatch
                  ? '逐项校验槽位冲突并独立写回，旧版本将自动存入历史版本栈'
                  : `将产物媒体安全同步至工作台槽位 · ${singleItem.shotTitle || singleItem.shotId}`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 主体对比区 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* 单项对比视图 */}
          {!isBatch && (
            <>
              {/* 新旧媒体并排展示 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* 左侧：工作台当前槽位媒体 */}
                <div className="flex flex-col rounded-xl border border-[var(--border-secondary)] bg-[var(--bg-surface)] p-3">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-[var(--border-primary)]">
                    <span className="text-[11px] font-bold text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5 text-slate-400" />
                      当前槽位媒体 (旧)
                    </span>
                    <span className="text-[10px] font-mono text-[var(--text-tertiary)]">
                      {singleItem.currentRef ? '现有版本' : '无存量媒体'}
                    </span>
                  </div>
                  <div className="aspect-[16/9] w-full overflow-hidden rounded-lg bg-[var(--bg-base)] border border-[var(--border-primary)] flex items-center justify-center">
                    {singleItem.currentRef ? (
                      singleItem.mediaType === 'video' ? (
                        <video
                          src={singleItem.currentRef}
                          controls
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <img
                          src={singleItem.currentRef}
                          alt="当前槽位旧媒体"
                          className="h-full w-full object-cover"
                        />
                      )
                    ) : (
                      <div className="flex flex-col items-center gap-1 text-[11px] text-[var(--text-muted)]">
                        {singleItem.mediaType === 'video' ? (
                          <Film className="h-6 w-6 opacity-40 text-slate-400" />
                        ) : (
                          <ImageIcon className="h-6 w-6 opacity-40 text-slate-400" />
                        )}
                        <span>槽位为空（本次为首次写入）</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* 右侧：画布候选产物媒体 */}
                <div className="flex flex-col rounded-xl border border-[var(--accent-border)] bg-[var(--accent-bg)] p-3">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-[var(--accent-border)]">
                    <span className="text-[11px] font-bold text-[var(--accent-text)] uppercase tracking-wider flex items-center gap-1.5">
                      <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
                      画布候选产物 (新)
                    </span>
                    <span className="text-[10px] font-mono text-[var(--accent-text)]">
                      节点: {singleItem.sourceNodeId}
                    </span>
                  </div>
                  <div className="aspect-[16/9] w-full overflow-hidden rounded-lg bg-[var(--bg-base)] border border-[var(--accent-border)] flex items-center justify-center">
                    {singleItem.candidateRef ? (
                      singleItem.mediaType === 'video' ? (
                        <video
                          src={singleItem.candidateRef}
                          controls
                          autoPlay
                          muted
                          loop
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <img
                          src={singleItem.candidateRef}
                          alt="画布候选产物"
                          className="h-full w-full object-cover"
                        />
                      )
                    ) : (
                      <div className="text-[11px] text-[var(--error-text)]">未检测到产物内容</div>
                    )}
                  </div>
                </div>
              </div>

              {/* 差异摘要 */}
              <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-surface)] p-4 space-y-3">
                <h4 className="text-xs font-bold text-[var(--text-primary)] uppercase tracking-wider">
                  写入与版本差异摘要 (Diff Summary)
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
                  <div className="rounded-lg bg-[var(--bg-base)] p-2.5 border border-[var(--border-primary)]">
                    <p className="text-[10px] text-[var(--text-muted)]">目标镜头</p>
                    <p className="font-bold text-[var(--text-primary)] truncate mt-0.5">
                      {singleItem.shotTitle || singleItem.shotId}
                    </p>
                  </div>
                  <div className="rounded-lg bg-[var(--bg-base)] p-2.5 border border-[var(--border-primary)]">
                    <p className="text-[10px] text-[var(--text-muted)]">目标槽位</p>
                    <p className="font-bold text-[var(--text-primary)] mt-0.5">
                      {singleItem.targetType === 'keyframe' ? '关键帧 (Keyframe)' : '视频片段 (Interval)'}
                    </p>
                  </div>
                  <div className="rounded-lg bg-[var(--bg-base)] p-2.5 border border-[var(--border-primary)]">
                    <p className="text-[10px] text-[var(--text-muted)]">写入动作</p>
                    <p className="font-bold text-amber-300 mt-0.5">
                      {singleItem.currentRef ? '覆盖旧媒体 (旧版自动归档)' : '首次写入'}
                    </p>
                  </div>
                  <div className="rounded-lg bg-[var(--bg-base)] p-2.5 border border-[var(--border-primary)]">
                    <p className="text-[10px] text-[var(--text-muted)]">媒体格式</p>
                    <p className="font-bold text-[var(--text-primary)] uppercase mt-0.5">
                      {singleItem.mediaType}
                    </p>
                  </div>
                </div>

                {singleItem.promptSnapshot && (
                  <div className="rounded-lg bg-[var(--bg-base)] p-2.5 border border-[var(--border-primary)] text-[11px]">
                    <span className="text-[10px] text-[var(--text-muted)] block mb-1">
                      随附提示词快照:
                    </span>
                    <p className="text-[var(--text-secondary)] line-clamp-2 font-mono text-[10px]">
                      {singleItem.promptSnapshot}
                    </p>
                  </div>
                )}
              </div>

              {/* 过期冲突告警 (Stale Warning) */}
              {staleError && (
                <div className="rounded-xl border border-[var(--error-border)] bg-[var(--error-hover-bg)] p-4 space-y-2 text-xs animate-in shake duration-200">
                  <div className="flex items-center gap-2 font-bold text-[var(--error-text)]">
                    <AlertTriangle className="h-4 w-4 text-red-400" />
                    <span>检测到槽位并发修改冲突 (Stale Commit Blocked)</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-[var(--error-text)]/90">
                    {staleError.message}
                  </p>
                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--error-border)]/50">
                    <button
                      type="button"
                      onClick={() => handleSingleCommit(true)}
                      disabled={isSubmitting}
                      className="rounded-lg bg-red-600 hover:bg-red-500 px-3 py-1.5 text-[11px] font-bold text-white shadow transition-colors"
                    >
                      仍然强制覆盖写回
                    </button>
                  </div>
                </div>
              )}

              {/* 通用错误提示 */}
              {generalError && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{generalError}</span>
                </div>
              )}
            </>
          )}

          {/* 批量对比与状态列表视图 */}
          {isBatch && (
            <div className="space-y-4">
              <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-surface)] p-4">
                <div className="flex items-center justify-between text-xs font-bold text-[var(--text-primary)] mb-2">
                  <span>批量任务进度清单</span>
                  <span className="font-mono text-[var(--accent-text)]">
                    {batchProgress
                      ? `${batchProgress.completed} / ${batchProgress.total}`
                      : `待处理 ${items.length} 项`}
                  </span>
                </div>
                {batchProgress && (
                  <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--bg-hover)]">
                    <div
                      className="h-full bg-[var(--accent)] transition-all duration-300"
                      style={{
                        width: `${Math.round((batchProgress.completed / batchProgress.total) * 100)}%`,
                      }}
                    />
                  </div>
                )}
              </div>

              {/* 逐项列表与状态隔离展示 */}
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {items.map((item, index) => {
                  const result = batchProgress?.results[index];
                  return (
                    <div
                      key={item.sourceNodeId || index}
                      className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-surface)] p-2.5 text-xs"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {/* 候选缩略图 */}
                        <div className="h-10 w-16 shrink-0 overflow-hidden rounded border border-[var(--border-secondary)] bg-[var(--bg-base)]">
                          {item.mediaType === 'video' ? (
                            <video
                              src={item.candidateRef}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <img
                              src={item.candidateRef}
                              alt="thumb"
                              className="h-full w-full object-cover"
                            />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-[var(--text-primary)] truncate">
                            {item.shotTitle || item.shotId}
                          </p>
                          <p className="text-[10px] text-[var(--text-muted)] truncate">
                            {item.targetType === 'keyframe' ? '关键帧' : '视频片段'} · 节点:{' '}
                            {item.sourceNodeId}
                          </p>
                        </div>
                      </div>

                      {/* 逐项状态徽章 */}
                      <div className="shrink-0">
                        {!batchProgress ? (
                          <span className="rounded bg-[var(--bg-hover)] px-2 py-0.5 text-[10px] text-[var(--text-tertiary)]">
                            待提交
                          </span>
                        ) : !result ? (
                          <span className="flex items-center gap-1 text-[10px] text-amber-400">
                            <Loader2 className="h-3 w-3 animate-spin" /> 等待中
                          </span>
                        ) : result.success ? (
                          <span className="flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400 border border-emerald-500/20">
                            <CheckCircle className="h-3 w-3" /> 已写回 (v{result.result?.version.versionNumber})
                          </span>
                        ) : (
                          <span
                            className="flex items-center gap-1 rounded bg-red-500/10 px-2 py-0.5 text-[10px] font-bold text-red-400 border border-red-500/20"
                            title={result.error}
                          >
                            <AlertCircle className="h-3 w-3" /> 失败: {result.error?.slice(0, 16)}...
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* 底部按钮栏 */}
        <div className="flex items-center justify-between border-t border-[var(--border-primary)] px-6 py-4 bg-[var(--bg-surface)]">
          <p className="text-[11px] text-[var(--text-tertiary)]">
            安全写回保障：原媒体永不物理删除，可在分镜版本面板随时无损回滚。
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-lg border border-[var(--border-primary)] px-4 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
            >
              {batchProgress?.completed === batchProgress?.total && batchProgress?.total ? '关闭' : '取消'}
            </button>
            {!isBatch ? (
              <button
                type="button"
                onClick={() => handleSingleCommit(forceOverwrite)}
                disabled={isSubmitting}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] hover:opacity-90 px-4 py-2 text-xs font-bold text-white shadow-md transition-all active:scale-95 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    正在安全写回...
                  </>
                ) : (
                  <>
                    <CheckCircle className="h-3.5 w-3.5" />
                    确认写回导演台
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleBatchCommit}
                disabled={isSubmitting || Boolean(batchProgress && batchProgress.completed >= batchProgress.total)}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] hover:opacity-90 px-4 py-2 text-xs font-bold text-white shadow-md transition-all active:scale-95 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    批量写回进行中...
                  </>
                ) : batchProgress !== null && batchProgress.completed === batchProgress.total ? (
                  <>
                    <CheckCircle className="h-3.5 w-3.5" />
                    批量写回已完成
                  </>
                ) : (
                  <>
                    <Upload className="h-3.5 w-3.5" />
                    开始一键批量写回
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
