/**
 * Storage Bus Service
 * 多标签页同步通信总线：基于 BroadcastChannel('bigbanana_storage_bus')，实现跨标签页存储变更广播与订阅。
 * BroadcastChannel 不可用时优雅降级为 no-op。
 * 注意：本文件严格独立，不得依赖 storageService，避免循环引用。
 */

export type StorageChangeKind = 'episode' | 'project' | 'canvas';

export interface StorageChangeEvent {
  kind: StorageChangeKind;
  id?: string;
  senderId: string;
  timestamp: number;
}

export const STORAGE_BUS_CHANNEL_NAME = 'bigbanana_storage_bus';

// 生成当前标签页唯一实例 ID（用于过滤自身广播，防止同页面多实例回环）
export const TAB_SESSION_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tab_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

let channel: BroadcastChannel | null = null;
const subscribers = new Set<(event: StorageChangeEvent) => void>();
let locallyEditing = false;

// 初始化 BroadcastChannel，不可用时降级为 null
try {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(STORAGE_BUS_CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as StorageChangeEvent | undefined;
      if (!data || !data.kind) return;
      // 忽略来自当前标签页自身的消息（防回环）
      if (data.senderId && data.senderId === TAB_SESSION_ID) return;

      subscribers.forEach(cb => {
        try {
          cb(data);
        } catch (err) {
          console.error('[StorageBus] Subscriber execution error:', err);
        }
      });
    };
    channel.onmessageerror = (err) => {
      console.warn('[StorageBus] BroadcastChannel message error:', err);
    };
  }
} catch (e) {
  console.warn('[StorageBus] BroadcastChannel not supported or failed to initialize, degrading to no-op:', e);
  channel = null;
}

// 全局监听用户输入事件，自动记录当前页面的编辑状态
if (typeof window !== 'undefined') {
  window.addEventListener('input', () => {
    locallyEditing = true;
  }, { passive: true });
}

/**
 * 设置当前标签页是否有未保存修改/正在编辑
 */
export function setLocalEditing(editing: boolean): void {
  locallyEditing = editing;
}

/**
 * 判断当前页面是否有未保存内容或正在编辑
 */
export function isLocalEditing(): boolean {
  if (locallyEditing) return true;
  if (typeof document !== 'undefined' && document.activeElement) {
    const el = document.activeElement as HTMLElement;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) {
      return true;
    }
  }
  return false;
}

/**
 * 广播存储变更事件
 * @param kind 变更类型: 'episode' | 'project' | 'canvas'
 * @param id 变更实体的主键 ID（可选）
 */
export function broadcastStorageChanged(kind: StorageChangeKind, id?: string): void {
  // 本地成功写入并广播时，说明本地最新状态已持久化，重置编辑标记
  locallyEditing = false;

  if (!channel) return;
  try {
    const event: StorageChangeEvent = {
      kind,
      id,
      senderId: TAB_SESSION_ID,
      timestamp: Date.now(),
    };
    channel.postMessage(event);
  } catch (err) {
    console.warn('[StorageBus] Failed to postMessage (non-fatal):', err);
  }
}

/**
 * 订阅跨标签页存储变更事件
 * @param cb 回调函数，接收其他标签页发出的变更事件
 * @returns 取消订阅函数；BroadcastChannel 不可用时返回 no-op 取消函数
 */
export function subscribeStorageChanges(cb: (event: StorageChangeEvent) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export const storageBusService = {
  broadcastStorageChanged,
  subscribeStorageChanges,
  setLocalEditing,
  isLocalEditing,
  TAB_SESSION_ID,
};

export default storageBusService;
