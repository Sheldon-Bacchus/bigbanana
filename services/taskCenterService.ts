import { GenerationTaskEntity } from '../types';
import {
  saveGenerationTask,
  listGenerationTasks,
  listAllGenerationTasks,
} from './storageService';

/**
 * 任务中心服务类型定义
 */
export interface EnqueueTaskInput {
  graphId?: string;
  nodeId?: string;
  taskType: 'text-to-image' | 'image-to-video' | 'fl2v';
  promptPayload: GenerationTaskEntity['promptPayload'];
}

export type TaskListener = (tasks: GenerationTaskEntity[]) => void;
export type TaskExecutor = (task: GenerationTaskEntity) => Promise<void>;

/**
 * 常量配置
 */
const MAX_CONCURRENT_RUNNING = 2; // 内置调度最多 2 个 running 任务
const TEN_MINUTES_MS = 10 * 60 * 1000; // 10分钟超时判定
const POLLING_INTERVAL_MS = 1500; // 1.5s 轮询同步与超时巡检

/**
 * 内部状态
 */
const taskCache = new Map<string, GenerationTaskEntity>();
const listeners = new Set<TaskListener>();
let activeExecutor: TaskExecutor | null = null;
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let isScheduling = false;
let isInitialized = false;

/**
 * 生成稳定的任务 UUID
 */
const generateTaskUuid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `task-${crypto.randomUUID()}`;
  }
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `task-${timestamp}-${randomPart}`;
};

/**
 * 广播任务变更事件给所有订阅者
 */
const notifyListeners = (): void => {
  if (listeners.size === 0) return;
  const currentTasks = Array.from(taskCache.values()).sort(
    (a, b) => b.createdAt - a.createdAt
  );
  listeners.forEach((listener) => {
    try {
      listener(currentTasks);
    } catch (err) {
      console.error('[taskCenterService] 订阅者通知执行异常:', err);
    }
  });
};

/**
 * 恢复与超时巡检：
 * 刷新后从 generation_tasks 恢复；running 超过 10 分钟无更新视为 interrupted（标 failed 并写 error）
 */
export const recoverTasks = async (): Promise<GenerationTaskEntity[]> => {
  try {
    const persistedTasks = await listAllGenerationTasks();
    const now = Date.now();
    let hasChanges = false;

    // 清空重构缓存，保持权威状态
    taskCache.clear();

    for (const task of persistedTasks) {
      let currentTask = task;
      // 检查中断超时任务
      if (currentTask.status === 'running') {
        const lastUpdated = currentTask.updatedAt || currentTask.createdAt || 0;
        if (now - lastUpdated > TEN_MINUTES_MS) {
          currentTask = {
            ...currentTask,
            status: 'failed',
            error: '任务执行超时或被意外中断 (超过10分钟无更新)',
            updatedAt: now,
          };
          await saveGenerationTask(currentTask);
          hasChanges = true;
        }
      }
      taskCache.set(currentTask.id, currentTask);
    }

    if (hasChanges) {
      notifyListeners();
    }

    return Array.from(taskCache.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
  } catch (error) {
    console.error('[taskCenterService] 恢复任务失败:', error);
    return Array.from(taskCache.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
  }
};

/**
 * 确保服务已初始化（从持久化恢复一次）
 */
const ensureInitialized = async (): Promise<void> => {
  if (!isInitialized) {
    isInitialized = true;
    await recoverTasks();
  }
};

/**
 * 调度核心：
 * 内置调度最多 2 个 running；无执行器时任务保持 queued 并记录原因，禁止伪造成功
 */
const scheduleNext = async (): Promise<void> => {
  if (isScheduling) return;
  isScheduling = true;

  try {
    await ensureInitialized();

    // 检查是否有注册执行器
    if (!activeExecutor) {
      const queuedCount = Array.from(taskCache.values()).filter(
        (t) => t.status === 'queued'
      ).length;
      if (queuedCount > 0) {
        // 无执行器时任务保持 queued 并记录原因，禁止伪造成功
        console.warn(
          `[taskCenterService] 当前暂无注册的执行器，${queuedCount} 个任务保持 queued 状态等待处理`
        );
      }
      return;
    }

    // 计算当前正在运行的任务数量
    const runningTasks = Array.from(taskCache.values()).filter(
      (t) => t.status === 'running'
    );
    const availableSlots = MAX_CONCURRENT_RUNNING - runningTasks.length;

    if (availableSlots <= 0) {
      return;
    }

    // 挑选最早排队的任务 (FIFO 先进先出)
    const queuedTasks = Array.from(taskCache.values())
      .filter((t) => t.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, availableSlots);

    if (queuedTasks.length === 0) {
      return;
    }

    for (const task of queuedTasks) {
      // 状态迁移：queued -> running
      const updated = await updateTask(task.id, {
        status: 'running',
        progress: task.progress > 0 ? task.progress : 1,
      });

      if (!updated) continue;

      // 异步分发给执行器
      const executorRef = activeExecutor;
      (async () => {
        try {
          if (executorRef) {
            await executorRef(updated);
          }
          // 执行完毕后若仍为 running 则自动标为 succeeded
          const latest = taskCache.get(task.id);
          if (latest && latest.status === 'running') {
            await updateTask(task.id, {
              status: 'succeeded',
              progress: 100,
            });
          }
        } catch (err: unknown) {
          const errorMessage =
            err instanceof Error ? err.message : String(err) || '任务执行发生异常';
          console.error(`[taskCenterService] 任务 ${task.id} 执行失败:`, err);
          const latest = taskCache.get(task.id);
          // 若未被取消，则标记失败
          if (latest && (latest.status === 'running' || latest.status === 'queued')) {
            await updateTask(task.id, {
              status: 'failed',
              error: errorMessage,
            });
          }
        } finally {
          // 触发后续排队调度
          void scheduleNext();
        }
      })();
    }
  } finally {
    isScheduling = false;
  }
};

/**
 * 启动 1.5s 周期性轮询与心跳巡检
 */
const startPolling = (): void => {
  if (pollingTimer) return;
  pollingTimer = setInterval(async () => {
    try {
      const persistedTasks = await listAllGenerationTasks();
      const now = Date.now();
      let hasChanges = false;

      // 比对合并外部变更与超时判定
      for (const persisted of persistedTasks) {
        let task = persisted;
        if (task.status === 'running') {
          const lastUpdated = task.updatedAt || task.createdAt || 0;
          if (now - lastUpdated > TEN_MINUTES_MS) {
            task = {
              ...task,
              status: 'failed',
              error: '任务执行超时或被意外中断 (超过10分钟无更新)',
              updatedAt: now,
            };
            await saveGenerationTask(task);
            hasChanges = true;
          }
        }

        const cached = taskCache.get(task.id);
        if (
          !cached ||
          cached.updatedAt !== task.updatedAt ||
          cached.status !== task.status ||
          cached.progress !== task.progress
        ) {
          taskCache.set(task.id, task);
          hasChanges = true;
        }
      }

      if (hasChanges) {
        notifyListeners();
      }

      // 尝试调度排队任务
      void scheduleNext();
    } catch (err) {
      console.warn('[taskCenterService] 轮询同步失败:', err);
    }
  }, POLLING_INTERVAL_MS);
};

/**
 * 停止周期性轮询
 */
const stopPolling = (): void => {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
};

/**
 * 入队新任务：
 * 生成 task-uuid，status 'queued'，progress 0，持久化
 */
export const enqueueTask = async (
  input: EnqueueTaskInput
): Promise<GenerationTaskEntity> => {
  await ensureInitialized();

  const id = generateTaskUuid();
  const now = Date.now();

  const newTask: GenerationTaskEntity = {
    id,
    graphId: input.graphId || '',
    nodeId: input.nodeId || '',
    taskType: input.taskType,
    status: 'queued',
    progress: 0,
    promptPayload: input.promptPayload,
    createdAt: now,
    updatedAt: now,
  };

  taskCache.set(id, newTask);
  await saveGenerationTask(newTask);
  notifyListeners();

  // 触发调度
  void scheduleNext();

  return newTask;
};

/**
 * 查询所有生成任务（按创建时间倒序）
 */
export const listAllTasks = async (): Promise<GenerationTaskEntity[]> => {
  await ensureInitialized();
  return Array.from(taskCache.values()).sort(
    (a, b) => b.createdAt - a.createdAt
  );
};

/**
 * 按图谱 ID 查询任务
 */
export const listTasksByGraph = async (
  graphId: string
): Promise<GenerationTaskEntity[]> => {
  await ensureInitialized();
  const dbTasks = await listGenerationTasks(graphId);
  return dbTasks;
};

/**
 * 更新任务状态与进度
 */
export const updateTask = async (
  id: string,
  patch: Partial<
    Pick<GenerationTaskEntity, 'status' | 'progress' | 'remoteTaskId' | 'error'>
  >
): Promise<GenerationTaskEntity | null> => {
  await ensureInitialized();

  let task = taskCache.get(id);
  if (!task) {
    const all = await listAllGenerationTasks();
    all.forEach((t) => taskCache.set(t.id, t));
    task = taskCache.get(id);
  }

  if (!task) {
    return null;
  }

  const prevStatus = task.status;
  const updatedTask: GenerationTaskEntity = {
    ...task,
    ...patch,
    updatedAt: Date.now(),
  };

  taskCache.set(id, updatedTask);
  await saveGenerationTask(updatedTask);
  notifyListeners();

  // 状态发生变化时若释放了 running 插槽，尝试调度后续排队任务
  if (prevStatus !== updatedTask.status && updatedTask.status !== 'running') {
    void scheduleNext();
  }

  return updatedTask;
};

/**
 * 取消任务：
 * 状态机规则：queued/running -> canceled
 */
export const cancelTask = async (
  id: string
): Promise<GenerationTaskEntity | null> => {
  await ensureInitialized();

  let task = taskCache.get(id);
  if (!task) {
    const all = await listAllGenerationTasks();
    all.forEach((t) => taskCache.set(t.id, t));
    task = taskCache.get(id);
  }

  if (!task) {
    return null;
  }

  // 仅允许取消 queued 或 running 状态的任务
  if (task.status !== 'queued' && task.status !== 'running') {
    return task;
  }

  const updatedTask: GenerationTaskEntity = {
    ...task,
    status: 'canceled',
    updatedAt: Date.now(),
  };

  taskCache.set(id, updatedTask);
  await saveGenerationTask(updatedTask);
  notifyListeners();

  // 释放了插槽或变更了队列，调度下一任务
  void scheduleNext();

  return updatedTask;
};

/**
 * 重试任务：
 * 状态机规则：failed/canceled -> queued 且 progress 归零
 */
export const retryTask = async (
  id: string
): Promise<GenerationTaskEntity | null> => {
  await ensureInitialized();

  let task = taskCache.get(id);
  if (!task) {
    const all = await listAllGenerationTasks();
    all.forEach((t) => taskCache.set(t.id, t));
    task = taskCache.get(id);
  }

  if (!task) {
    return null;
  }

  // 仅允许重试 failed 或 canceled 状态的任务
  if (task.status !== 'failed' && task.status !== 'canceled') {
    return task;
  }

  const updatedTask: GenerationTaskEntity = {
    ...task,
    status: 'queued',
    progress: 0,
    error: undefined,
    updatedAt: Date.now(),
  };

  taskCache.set(id, updatedTask);
  await saveGenerationTask(updatedTask);
  notifyListeners();

  // 触发调度
  void scheduleNext();

  return updatedTask;
};

/**
 * 订阅任务列表：
 * 1.5s 轮询或事件触发，返回销毁清理回调
 */
export const subscribe = (listener: TaskListener): (() => void) => {
  listeners.add(listener);

  // 立即返回当前已有数据
  void ensureInitialized().then(() => {
    if (listeners.has(listener)) {
      const tasks = Array.from(taskCache.values()).sort(
        (a, b) => b.createdAt - a.createdAt
      );
      listener(tasks);
    }
  });

  // 启动 1.5s 轮询
  startPolling();

  return () => {
    listeners.delete(listener);
    // 无活跃订阅者时清理轮询，节约资源
    if (listeners.size === 0) {
      stopPolling();
    }
  };
};

/**
 * 注册生成执行器：
 * 内置调度最多 2 个 running；无执行器时任务保持 queued 并记录原因，禁止伪造成功
 */
export const registerExecutor = (fn: TaskExecutor): (() => void) => {
  activeExecutor = fn;
  console.info('[taskCenterService] 成功注册任务执行器，开始调度排队任务');

  // 立即触发一次调度
  void scheduleNext();

  return () => {
    if (activeExecutor === fn) {
      activeExecutor = null;
      console.info('[taskCenterService] 任务执行器已注销');
    }
  };
};

/**
 * 默认聚合导出对象
 */
export const taskCenterService = {
  enqueueTask,
  listAllTasks,
  listTasksByGraph,
  updateTask,
  cancelTask,
  retryTask,
  subscribe,
  registerExecutor,
  recoverTasks,
};

export default taskCenterService;
