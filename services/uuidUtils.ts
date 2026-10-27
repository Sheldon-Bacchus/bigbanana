/**
 * UUID 与强类型稳定 ID 工具模块
 * 遵循 006 规范与数据模型第 3 节 (稳定不可变 UUID 体系)
 */

function generateFallbackUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * 生成带前缀的强类型唯一标识 (如 cnode-..., mver-..., cgraph-..., task-...)
 * 优先采用 crypto.randomUUID()，无则回退至标准随机 UUID
 */
export function createTypedId(prefix: string): string {
  let uuid: string;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      uuid = crypto.randomUUID();
    } catch {
      uuid = generateFallbackUUID();
    }
  } else {
    uuid = generateFallbackUUID();
  }
  return `${prefix}-${uuid}`;
}

/**
 * 维持既有 ID 的稳定性；若传入 ID 为空或无效，则生成带指定前缀的新 ID
 */
export function resolveStableId(existing?: string | null, prefix = 'id'): string {
  if (existing && typeof existing === 'string' && existing.trim().length > 0) {
    return existing.trim();
  }
  return createTypedId(prefix);
}
