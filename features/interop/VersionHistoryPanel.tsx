import React, { useEffect, useState, useCallback } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Film,
  History,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { MediaVersionEntity, CommitRecordEntity } from '../../types';
import { useProjectContext } from '../../contexts/ProjectContext';
import {
  listHistory,
  listHistoryRecords,
  rollbackToVersion,
  RollbackResult,
} from './commitService';

export interface VersionHistoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  targetType: 'keyframe' | 'interval';
  targetId: string;
  shotId?: string;
  shotTitle?: string;
  onRollbackSuccess?: (storageRef: string) => void;
}

export const VersionHistoryPanel: React.FC<VersionHistoryPanelProps> = ({
  isOpen,
  onClose,
  targetType,
  targetId,
  shotId,
  shotTitle,
  onRollbackSuccess,
}) => {
  const { updateEpisode } = useProjectContext();

  const [versions, setVersions] = useState<MediaVersionEntity[]>([]);
  const [records, setRecords] = useState<CommitRecordEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const effectiveShotId = shotId || targetId;

  const loadData = useCallback(async () => {
    if (!targetId) return;
    setLoading(true);
    setError(null);
    try {
      const [vList, rList] = await Promise.all([
        listHistory(targetType, targetId),
        listHistoryRecords(targetId),
      ]);
      setVersions(vList);
      setRecords(rList);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '加载版本历史失败');
    } finally {
      setLoading(false);
    }
  }, [targetType, targetId]);

  useEffect(() => {
    if (isOpen) {
      loadData();
      setSuccessMsg(null);
    }
  }, [isOpen, loadData]);

  if (!isOpen) return null;

  /**
   * 执行版本回滚
   */
  const handleRollback = async (version: MediaVersionEntity) => {
    setRollingBackId(version.id);
    setError(null);
    setSuccessMsg(null);

    try {
      const rollbackRes: RollbackResult = await rollbackToVersion(version.id);

      // 回滚成功后，通过 context 更新分镜槽位实体并触发自动存盘
      updateEpisode((prev) => ({
        ...prev,
        shots: (prev.shots || []).map((shot) => {
          if (shot.id !== effectiveShotId) return shot;

          if (targetType === 'keyframe') {
            const keyframes = (shot.keyframes || []).map((kf) => {
              if (kf.id === targetId || kf.type === 'start') {
                return {
                  ...kf,
                  imageUrl: rollbackRes.storageRef,
                  status: 'completed' as const,
                };
              }
              return kf;
            });
            return { ...shot, keyframes };
          } else {
            const interval = shot.interval
              ? {
                  ...shot.interval,
                  videoUrl: rollbackRes.storageRef,
                  status: 'completed' as const,
                }
              : {
                  id: `interval-${shot.id}`,
                  startKeyframeId: shot.keyframes?.[0]?.id || '',
                  endKeyframeId: shot.keyframes?.[1]?.id || '',
                  duration: 5,
                  motionStrength: 0.5,
                  videoUrl: rollbackRes.storageRef,
                  status: 'completed' as const,
                };
            return { ...shot, interval };
          }
        }),
      }));

      setSuccessMsg(`已成功回滚至版本 v${version.versionNumber}`);
      onRollbackSuccess?.(rollbackRes.storageRef);

      // 重新拉取最新版本激活状态
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '回滚版本失败');
    } finally {
      setRollingBackId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex justify-end bg-black/60 backdrop-blur-sm animate-in fade-in duration-150 select-none">
      <div className="flex h-full w-full max-w-lg flex-col border-l border-[var(--border-primary)] bg-[var(--bg-elevated)] shadow-2xl animate-in slide-in-from-right duration-200">
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between border-b border-[var(--border-primary)] px-5 py-4 bg-[var(--bg-surface)]">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent-bg)] border border-[var(--accent-border)] text-[var(--accent-text)]">
              <History className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-[var(--text-primary)]">
                版本历史栈 · {shotTitle || effectiveShotId}
              </h3>
              <p className="text-[10px] text-[var(--text-muted)]">
                {targetType === 'keyframe' ? '关键帧媒体历史' : '分镜视频媒体历史'} · 槽位 ID:{' '}
                {targetId}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 提示横幅 */}
        {successMsg && (
          <div className="mx-5 mt-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
            <CheckCircle className="h-4 w-4 shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        {error && (
          <div className="mx-5 mt-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* 版本卡片列表 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-xs text-[var(--text-muted)]">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--accent)]" />
              <span>正在拉取版本栈...</span>
            </div>
          ) : versions.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border-primary)] p-6 text-center text-xs text-[var(--text-muted)]">
              <Clock className="h-8 w-8 opacity-30 mb-2 text-slate-400" />
              <p className="font-medium text-[var(--text-secondary)]">暂无历史版本记录</p>
              <p className="mt-1 text-[11px] text-[var(--text-tertiary)] leading-relaxed">
                在画布中生成满意产物后点击「写回导演台」，每次写回都会自动沉淀为不可物理删除的独立版本。
              </p>
            </div>
          ) : (
            versions.map((ver) => {
              const isCurrent = ver.isCurrent;
              const isRolling = rollingBackId === ver.id;

              return (
                <div
                  key={ver.id}
                  className={`rounded-xl border p-4 transition-all ${
                    isCurrent
                      ? 'border-emerald-500/50 bg-emerald-500/[0.04] shadow-sm'
                      : 'border-[var(--border-primary)] bg-[var(--bg-surface)] hover:border-[var(--border-secondary)]'
                  }`}
                >
                  <div className="flex items-center justify-between pb-2 mb-3 border-b border-[var(--border-primary)]/60">
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-mono text-xs font-bold px-2 py-0.5 rounded ${
                          isCurrent
                            ? 'bg-emerald-500 text-slate-950 font-black'
                            : 'bg-[var(--bg-hover)] text-[var(--text-secondary)]'
                        }`}
                      >
                        v{ver.versionNumber}
                      </span>
                      {isCurrent ? (
                        <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-400">
                          <CheckCircle className="h-3 w-3" />
                          当前活跃版本
                        </span>
                      ) : (
                        <span className="text-[10px] text-[var(--text-tertiary)]">历史快照</span>
                      )}
                    </div>
                    <span className="text-[10px] font-mono text-[var(--text-muted)]">
                      {new Date(ver.createdAt).toLocaleString()}
                    </span>
                  </div>

                  {/* 媒体预览 */}
                  <div className="grid grid-cols-3 gap-3 items-center">
                    <div className="col-span-1 aspect-[16/9] overflow-hidden rounded-lg border border-[var(--border-primary)] bg-[var(--bg-base)] flex items-center justify-center">
                      {ver.storageRef ? (
                        ver.mediaType === 'video' ? (
                          <video
                            src={ver.storageRef}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <img
                            src={ver.storageRef}
                            alt={`v${ver.versionNumber}`}
                            className="h-full w-full object-cover"
                          />
                        )
                      ) : (
                        <div className="text-[10px] text-[var(--text-muted)]">无预览</div>
                      )}
                    </div>

                    <div className="col-span-2 space-y-1.5 min-w-0">
                      <p className="text-[10px] text-[var(--text-muted)] flex items-center gap-1 truncate">
                        <span>来源:</span>
                        <span className="text-[var(--text-secondary)] font-medium">
                          {ver.provenance?.source === 'canvas_commit'
                            ? `画布写回 (${ver.provenance.canvasNodeId || 'Node'})`
                            : ver.provenance?.source === 'import'
                            ? '工程导入'
                            : '工作台手动/基线'}
                        </span>
                      </p>

                      {ver.provenance?.promptSnapshot && (
                        <p className="text-[9px] text-[var(--text-tertiary)] line-clamp-2 font-mono bg-[var(--bg-base)] p-1.5 rounded border border-[var(--border-primary)]/50">
                          {ver.provenance.promptSnapshot}
                        </p>
                      )}

                      <div className="pt-1 flex items-center justify-end">
                        {isCurrent ? (
                          <span className="text-[10px] text-emerald-400 font-bold py-1">
                            ✓ 正在使用中
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleRollback(ver)}
                            disabled={isRolling}
                            className="flex items-center gap-1 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-hover)] px-2.5 py-1 text-[10px] font-bold text-[var(--text-primary)] hover:border-[var(--accent)] hover:bg-[var(--accent-bg)] hover:text-[var(--accent-text)] transition-all disabled:opacity-50"
                          >
                            {isRolling ? (
                              <>
                                <Loader2 className="h-3 w-3 animate-spin" />
                                回滚中...
                              </>
                            ) : (
                              <>
                                <RotateCcw className="h-3 w-3 text-amber-400" />
                                回滚到此版本
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 底部关闭栏 */}
        <div className="flex items-center justify-between border-t border-[var(--border-primary)] px-5 py-3 bg-[var(--bg-surface)]">
          <span className="text-[10px] text-[var(--text-muted)]">
            共 {versions.length} 个历史版本
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            关闭面板
          </button>
        </div>
      </div>
    </div>
  );
};
