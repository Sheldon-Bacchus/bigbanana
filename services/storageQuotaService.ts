/**
 * Storage Quota Service
 * 存储配额监控服务：基于 navigator.storage.estimate()，检测浏览器存储配额与使用情况。
 * 阈值：
 * - ratio >= 0.8: 黄色预警（存储空间已使用超过 80%，建议导出归档）
 * - ratio >= 0.95: 红色熔断提示（请清理 OPFS 临时视频或导出整包）
 * 不得抛错阻塞应用。
 */

export interface StorageEstimateResult {
  usage: number;
  quota: number;
  ratio: number;
}

export type QuotaLevel = 'normal' | 'warning' | 'danger';

export const QUOTA_WARNING_RATIO = 0.8;
export const QUOTA_DANGER_RATIO = 0.95;

let cachedEstimate: StorageEstimateResult | null = null;
const subscribers = new Set<(estimate: StorageEstimateResult | null) => void>();

/**
 * 格式化字节大小为可读字符串 (B, KB, MB, GB, TB)
 */
export function formatStorageBytes(bytes: number): string {
  if (!bytes || bytes <= 0 || isNaN(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 获取配额警报级别
 * - normal: ratio < 0.8
 * - warning: ratio >= 0.8 && ratio < 0.95
 * - danger: ratio >= 0.95
 */
export function getQuotaLevel(ratio: number): QuotaLevel {
  if (ratio >= QUOTA_DANGER_RATIO) return 'danger';
  if (ratio >= QUOTA_WARNING_RATIO) return 'warning';
  return 'normal';
}

/**
 * 获取当前存储配额与使用量
 * 基于 navigator.storage.estimate()，不支持或失败时返回 null，不抛错阻塞应用
 */
export async function getStorageEstimate(): Promise<StorageEstimateResult | null> {
  try {
    if (
      typeof navigator === 'undefined' ||
      !navigator.storage ||
      typeof navigator.storage.estimate !== 'function'
    ) {
      return null;
    }

    const estimate = await navigator.storage.estimate();
    const usage = typeof estimate.usage === 'number' ? estimate.usage : 0;
    const quota = typeof estimate.quota === 'number' ? estimate.quota : 0;
    const ratio = quota > 0 ? usage / quota : 0;

    return { usage, quota, ratio };
  } catch (error) {
    console.warn('[StorageQuota] navigator.storage.estimate() failed (non-fatal):', error);
    return null;
  }
}

/**
 * 刷新存储配额估算并通知所有已注册的订阅者
 */
export async function refreshStorageEstimate(): Promise<StorageEstimateResult | null> {
  const result = await getStorageEstimate();
  cachedEstimate = result;
  subscribers.forEach(cb => {
    try {
      cb(cachedEstimate);
    } catch (err) {
      console.error('[StorageQuota] Subscriber notification error:', err);
    }
  });
  return result;
}

/**
 * 订阅存储配额变更
 * @param cb 回调函数，接收当前的存储配额信息（或 null）
 * @returns 取消订阅函数
 */
export function subscribeQuota(cb: (estimate: StorageEstimateResult | null) => void): () => void {
  subscribers.add(cb);

  // 立即使用缓存数据通知；若尚无缓存，触发一次刷新
  if (cachedEstimate !== null) {
    try {
      cb(cachedEstimate);
    } catch (err) {
      console.error('[StorageQuota] Immediate subscriber error:', err);
    }
  } else {
    void refreshStorageEstimate();
  }

  return () => {
    subscribers.delete(cb);
  };
}

export const storageQuotaService = {
  getStorageEstimate,
  refreshStorageEstimate,
  subscribeQuota,
  formatStorageBytes,
  getQuotaLevel,
  QUOTA_WARNING_RATIO,
  QUOTA_DANGER_RATIO,
};

export default storageQuotaService;
