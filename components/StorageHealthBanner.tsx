import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, AlertOctagon, RefreshCw, X } from 'lucide-react';
import {
  storageQuotaService,
  StorageEstimateResult,
  formatStorageBytes,
  QUOTA_WARNING_RATIO,
  QUOTA_DANGER_RATIO,
} from '../services/storageQuotaService';
import {
  storageBusService,
  StorageChangeEvent,
  isLocalEditing,
} from '../services/storageBusService';

interface ConflictState {
  visible: boolean;
  kind?: string;
  timestamp?: number;
}

export const StorageHealthBanner: React.FC = () => {
  const [estimate, setEstimate] = useState<StorageEstimateResult | null>(null);
  const [isQuotaDismissed, setIsQuotaDismissed] = useState(false);
  const [dismissedRatio, setDismissedRatio] = useState<number | null>(null);
  const [conflict, setConflict] = useState<ConflictState>({ visible: false });

  // 1. 订阅存储配额监控
  useEffect(() => {
    const unsubscribeQuota = storageQuotaService.subscribeQuota((newEstimate) => {
      setEstimate(newEstimate);
      // 如果此前关闭了黄色预警，但配额进一步恶化至熔断阈值 (>=0.95)，恢复显示
      if (
        newEstimate &&
        newEstimate.ratio >= QUOTA_DANGER_RATIO &&
        dismissedRatio !== null &&
        dismissedRatio < QUOTA_DANGER_RATIO
      ) {
        setIsQuotaDismissed(false);
      }
    });

    // 窗口重新获得焦点时主动刷新存储配额
    const handleFocus = () => {
      void storageQuotaService.refreshStorageEstimate();
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      unsubscribeQuota();
      window.removeEventListener('focus', handleFocus);
    };
  }, [dismissedRatio]);

  // 2. 订阅跨标签页变更事件
  useEffect(() => {
    const unsubscribeBus = storageBusService.subscribeStorageChanges((event: StorageChangeEvent) => {
      // 收到远端变更事件时，静默刷新本地存储配额估算
      void storageQuotaService.refreshStorageEstimate();

      // 需求：当收到其他标签页变更事件且当前页面有未保存/正在编辑时显示提示横幅
      if (isLocalEditing()) {
        setConflict({
          visible: true,
          kind: event.kind,
          timestamp: event.timestamp,
        });
      }
    });

    return () => {
      unsubscribeBus();
    };
  }, []);

  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  const handleDismissQuota = useCallback(() => {
    setIsQuotaDismissed(true);
    if (estimate) {
      setDismissedRatio(estimate.ratio);
    }
  }, [estimate]);

  const handleDismissConflict = useCallback(() => {
    setConflict({ visible: false });
  }, []);

  const showQuotaWarning =
    estimate !== null &&
    estimate.ratio >= QUOTA_WARNING_RATIO &&
    !isQuotaDismissed;

  const isDangerQuota = estimate !== null && estimate.ratio >= QUOTA_DANGER_RATIO;

  // 无配额警报且无多标签冲突时，完全不占用 DOM 结构
  if (!showQuotaWarning && !conflict.visible) {
    return null;
  }

  const getKindLabel = (kind?: string) => {
    switch (kind) {
      case 'episode':
        return '剧集';
      case 'project':
        return '项目';
      case 'canvas':
        return '画布';
      default:
        return '数据';
    }
  };

  return (
    <div
      aria-label="Storage health and sync alerts"
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[55] w-[90%] max-w-2xl pointer-events-none flex flex-col gap-2"
    >
      {/* 多标签页冲突横幅 */}
      {conflict.visible && (
        <div className="pointer-events-auto rounded-lg border border-amber-500/50 bg-amber-950/95 text-amber-100 px-4 py-2.5 shadow-2xl backdrop-blur-md flex items-center justify-between gap-3 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-center gap-2.5 min-w-0">
            <RefreshCw className="w-4 h-4 text-amber-400 flex-shrink-0 animate-spin-reverse" />
            <div className="text-xs leading-relaxed">
              <span className="font-semibold text-amber-300">
                检测到其他标签页修改
              </span>
              <span className="text-amber-200/90 ml-1.5">
                已在其他标签页更新{getKindLabel(conflict.kind)}，当前页面有正在编辑的未保存内容。
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={handleReload}
              className="px-2.5 py-1 text-xs font-semibold rounded bg-amber-500 hover:bg-amber-400 text-black shadow transition-all active:scale-95 flex items-center gap-1.5"
            >
              <RefreshCw className="w-3 h-3" />
              点击立即重新载入
            </button>
            <button
              type="button"
              onClick={handleDismissConflict}
              className="p-1 rounded text-amber-300 hover:text-white hover:bg-amber-800/50 transition-colors"
              title="关闭提示"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* 存储配额预警横幅 */}
      {showQuotaWarning && estimate && (
        <div
          className={`pointer-events-auto rounded-lg border px-4 py-2.5 shadow-2xl backdrop-blur-md flex items-center justify-between gap-3 animate-in fade-in slide-in-from-top-2 duration-200 ${
            isDangerQuota
              ? 'border-red-500/60 bg-red-950/95 text-red-100'
              : 'border-yellow-500/50 bg-yellow-950/95 text-yellow-100'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            {isDangerQuota ? (
              <AlertOctagon className="w-4 h-4 text-red-400 flex-shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0" />
            )}
            <div className="text-xs leading-relaxed">
              {isDangerQuota ? (
                <>
                  <span className="font-semibold text-red-300">
                    红色熔断提示：存储空间已使用 {(estimate.ratio * 100).toFixed(0)}%
                  </span>
                  <span className="text-red-200/90 ml-1.5">
                    请清理 OPFS 临时视频或导出整包。({formatStorageBytes(estimate.usage)} / {formatStorageBytes(estimate.quota)})
                  </span>
                </>
              ) : (
                <>
                  <span className="font-semibold text-yellow-300">
                    黄色预警：存储空间已使用超过 80% ({(estimate.ratio * 100).toFixed(0)}%)
                  </span>
                  <span className="text-yellow-200/90 ml-1.5">
                    建议导出归档。({formatStorageBytes(estimate.usage)} / {formatStorageBytes(estimate.quota)})
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={() => void storageQuotaService.refreshStorageEstimate()}
              className={`p-1 rounded text-xs transition-colors ${
                isDangerQuota
                  ? 'text-red-300 hover:text-white hover:bg-red-800/50'
                  : 'text-yellow-300 hover:text-white hover:bg-yellow-800/50'
              }`}
              title="刷新存储估算"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleDismissQuota}
              className={`p-1 rounded transition-colors ${
                isDangerQuota
                  ? 'text-red-300 hover:text-white hover:bg-red-800/50'
                  : 'text-yellow-300 hover:text-white hover:bg-yellow-800/50'
              }`}
              title="暂时忽略"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default StorageHealthBanner;
