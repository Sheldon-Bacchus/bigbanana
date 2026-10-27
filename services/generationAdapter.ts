/**
 * 统一多模型生成适配器 (T15)
 *
 * 职责：
 * 1. 统一执行入口 runGenerationTask，为画图、生视频与首尾帧补间提供标准运行时。
 * 2. 深度复用 services/aiService.ts、services/newApiService.ts 与 modelConfigService。
 * 3. 严格的参数合法性前置校验与错误归一化处理。
 * 4. 默认端点保持为 https://api.antsk.cn，支持 AbortSignal 取消与优雅中断。
 * 5. 产物自动关联 OPFS 视频持久化或图像 Data URL。
 */

import {
  GenerationTaskEntity,
  AspectRatio,
  VideoDuration,
} from '../types';
import { generateImage, generateVideo } from './aiService';
import { persistVideoReference } from './videoStorageService';
import { getNewApiEndpoint, getNewApiTasks } from './newApiService';
import {
  getCurrentConfig,
  getDefaultAspectRatio,
  getDefaultVideoDuration,
} from './modelConfigService';
import { toFriendlyModerationMessage } from './errorMessageService';

/**
 * 默认官方模型端点，与系统配置强保持一致
 */
export const DEFAULT_GENERATION_ENDPOINT = 'https://api.antsk.cn';

/**
 * 获取当前有效的生成 API 基础端点
 */
export const getEffectiveGenerationEndpoint = (): string => {
  try {
    const endpoint = getNewApiEndpoint();
    return endpoint || DEFAULT_GENERATION_ENDPOINT;
  } catch {
    return DEFAULT_GENERATION_ENDPOINT;
  }
};

/**
 * 生成任务执行上下文
 */
export interface GenerationTaskContext {
  signal?: AbortSignal;
}

/**
 * 生成任务产物元数据
 */
export interface GenerationArtifact {
  mediaType: 'image' | 'video';
  storageRef: string;
}

/**
 * 生成任务统一执行结果
 */
export interface GenerationTaskExecutionResult {
  remoteTaskId?: string;
  artifacts?: GenerationArtifact[];
}

/**
 * 前置校验任务参数合法性
 */
export function validateGenerationTask(task: GenerationTaskEntity): void {
  if (!task || typeof task !== 'object') {
    throw new Error('无效的任务实体：任务对象不能为空');
  }

  if (!task.id) {
    throw new Error('无效的任务实体：缺少任务 ID');
  }

  const validTypes = ['text-to-image', 'image-to-video', 'fl2v'];
  if (!validTypes.includes(task.taskType)) {
    throw new Error(`不支持的生成任务类型: ${(task as any).taskType || '未指定'}`);
  }

  if (!task.promptPayload || typeof task.promptPayload !== 'object') {
    throw new Error('无效的任务实体：缺少 promptPayload');
  }

  const prompt = typeof task.promptPayload.prompt === 'string' ? task.promptPayload.prompt.trim() : '';
  const refUrls = Array.isArray(task.promptPayload.referenceUrls) ? task.promptPayload.referenceUrls : [];
  const params = task.promptPayload.params || {};

  if (task.taskType === 'text-to-image') {
    if (!prompt) {
      throw new Error('文生图任务校验失败：提示词 (prompt) 不能为空');
    }
  } else if (task.taskType === 'image-to-video') {
    const hasStartImage = Boolean(
      refUrls[0] ||
      params.startImageBase64 ||
      params.imageUrl ||
      params.startImage
    );
    if (!hasStartImage && !prompt) {
      throw new Error('图生视频任务校验失败：必须提供至少一张参考图像或有效的视频运动提示词');
    }
  } else if (task.taskType === 'fl2v') {
    const hasStartImage = Boolean(
      refUrls[0] ||
      params.startImageBase64 ||
      params.imageUrl ||
      params.startImage
    );
    if (!hasStartImage) {
      throw new Error('首尾帧生视频 (FL2V) 任务校验失败：必须提供首帧参考图像');
    }
  }
}

/**
 * 错误归一化：将各类网络、超时、风控及 API Key 异常统一转为可理解的中文错误
 */
export function normalizeGenerationError(error: unknown): Error {
  if (!error) {
    return new Error('未知生成异常');
  }

  if (error instanceof Error) {
    const msg = error.message || '';
    const lowerMsg = msg.toLowerCase();

    // 用户主动取消或 AbortError
    if (
      error.name === 'AbortError' ||
      lowerMsg.includes('abort') ||
      lowerMsg.includes('cancel') ||
      lowerMsg.includes('取消')
    ) {
      const cancelErr = new Error('生成任务已取消');
      cancelErr.name = 'AbortError';
      return cancelErr;
    }

    // 凭证与鉴权异常
    if (
      error.name === 'ApiKeyError' ||
      lowerMsg.includes('api key') ||
      lowerMsg.includes('apikey') ||
      lowerMsg.includes('401') ||
      lowerMsg.includes('未配置')
    ) {
      return new Error('生成失败：未配置有效的 API Key，请在模型设置中填写。');
    }

    // 内容风控与安全阻断
    if (
      lowerMsg.includes('safety') ||
      lowerMsg.includes('block') ||
      lowerMsg.includes('风控') ||
      lowerMsg.includes('违规') ||
      lowerMsg.includes('moderation') ||
      lowerMsg.includes('不符合要求')
    ) {
      return new Error(toFriendlyModerationMessage(msg) || '生成失败：提示词或输入图片可能被风控拦截，请调整后重试。');
    }

    // 速率限制 (429)
    if (lowerMsg.includes('429') || lowerMsg.includes('rate limit') || lowerMsg.includes('频繁')) {
      return new Error('生成失败：请求过于频繁（429 Too Many Requests），请稍后重试。');
    }

    // 服务端异常与超时 (500, 502, 503, 504, timeout)
    if (
      lowerMsg.includes('500') ||
      lowerMsg.includes('502') ||
      lowerMsg.includes('503') ||
      lowerMsg.includes('504') ||
      lowerMsg.includes('timeout') ||
      lowerMsg.includes('超时') ||
      lowerMsg.includes('繁忙')
    ) {
      return new Error('生成失败：上游模型服务繁忙或连接超时，请稍后重试。');
    }

    return error;
  }

  return new Error(String(error));
}

/**
 * 统一执行生成任务
 *
 * @param task 生成任务实体 (GenerationTaskEntity)
 * @param ctx 执行上下文，包含可选的 AbortSignal
 * @returns 生成结果，包含上游任务 ID (若有) 及产物数组 (mediaType 与 storageRef)
 */
export async function runGenerationTask(
  task: GenerationTaskEntity,
  ctx?: GenerationTaskContext
): Promise<GenerationTaskExecutionResult> {
  // 1. 检查中断状态
  if (ctx?.signal?.aborted) {
    const cancelErr = new Error('生成任务已取消');
    cancelErr.name = 'AbortError';
    throw cancelErr;
  }

  // 2. 前置参数校验
  validateGenerationTask(task);

  // 3. 构造中断竞速 Promise
  const createAbortListener = (): Promise<never> =>
    new Promise((_, reject) => {
      if (!ctx?.signal) return;
      if (ctx.signal.aborted) {
        const cancelErr = new Error('生成任务已取消');
        cancelErr.name = 'AbortError';
        reject(cancelErr);
        return;
      }
      ctx.signal.addEventListener(
        'abort',
        () => {
          const cancelErr = new Error('生成任务已取消');
          cancelErr.name = 'AbortError';
          reject(cancelErr);
        },
        { once: true }
      );
    });

  const executeCore = async (): Promise<GenerationTaskExecutionResult> => {
    // 4. 若已有上游 remoteTaskId，尝试查询是否已成功就绪
    if (task.remoteTaskId) {
      try {
        const taskPage = await getNewApiTasks({ taskId: task.remoteTaskId });
        const remote = taskPage?.items?.find((item) => item.task_id === task.remoteTaskId);
        if (remote && String(remote.status).toUpperCase() === 'SUCCESS' && remote.result_url) {
          const isImage = task.taskType === 'text-to-image';
          let storageRef = remote.result_url;
          if (!isImage) {
            storageRef = await persistVideoReference(storageRef);
          }
          return {
            remoteTaskId: task.remoteTaskId,
            artifacts: [
              {
                mediaType: isImage ? 'image' : 'video',
                storageRef,
              },
            ],
          };
        }
      } catch (err) {
        console.warn(`[generationAdapter] 查询已有 remoteTaskId ${task.remoteTaskId} 失败，回退重新生成:`, err);
      }
    }

    const { promptPayload, taskType } = task;
    const prompt = typeof promptPayload.prompt === 'string' ? promptPayload.prompt.trim() : '';
    const referenceUrls = Array.isArray(promptPayload.referenceUrls) ? promptPayload.referenceUrls : [];
    const params = promptPayload.params || {};

    // 5. 按任务类型分发调用现有成熟服务
    if (taskType === 'text-to-image') {
      const negativePrompt = typeof promptPayload.negativePrompt === 'string' ? promptPayload.negativePrompt : '';
      const aspectRatio = (params.aspectRatio as AspectRatio) || getDefaultAspectRatio() || '16:9';
      const isVariation = Boolean(params.isVariation);
      const hasTurnaround = Boolean(params.hasTurnaround);

      const imageUrl = await generateImage(
        prompt,
        referenceUrls,
        aspectRatio,
        isVariation,
        hasTurnaround,
        negativePrompt
      );

      return {
        artifacts: [
          {
            mediaType: 'image',
            storageRef: imageUrl,
          },
        ],
      };
    }

    if (taskType === 'image-to-video') {
      const effectivePrompt = prompt || 'Cinematic camera movement and continuous motion';
      const model = promptPayload.model || getCurrentConfig().videoModel.modelName || 'sora-2';
      const aspectRatio = (params.aspectRatio as AspectRatio) || getDefaultAspectRatio() || '16:9';
      const duration = (Number(params.duration) as VideoDuration) || getDefaultVideoDuration() || 8;
      const startImage =
        referenceUrls[0] ||
        (params.startImageBase64 as string) ||
        (params.imageUrl as string) ||
        (params.startImage as string);

      const rawVideoUrl = await generateVideo(
        effectivePrompt,
        startImage,
        undefined,
        model,
        aspectRatio,
        duration
      );

      // 持久化至 OPFS 或回退 Data URL
      const storageRef = await persistVideoReference(rawVideoUrl);

      return {
        artifacts: [
          {
            mediaType: 'video',
            storageRef,
          },
        ],
      };
    }

    if (taskType === 'fl2v') {
      const effectivePrompt = prompt || 'Smooth temporal transition between keyframes';
      const model = promptPayload.model || getCurrentConfig().videoModel.modelName || 'sora-2';
      const aspectRatio = (params.aspectRatio as AspectRatio) || getDefaultAspectRatio() || '16:9';
      const duration = (Number(params.duration) as VideoDuration) || getDefaultVideoDuration() || 8;
      const startImage =
        referenceUrls[0] ||
        (params.startImageBase64 as string) ||
        (params.imageUrl as string) ||
        (params.startImage as string);
      const endImage =
        referenceUrls[1] ||
        (params.endImageBase64 as string) ||
        (params.endImageUrl as string) ||
        (params.endImage as string);

      const rawVideoUrl = await generateVideo(
        effectivePrompt,
        startImage,
        endImage,
        model,
        aspectRatio,
        duration
      );

      // 持久化至 OPFS 或回退 Data URL
      const storageRef = await persistVideoReference(rawVideoUrl);

      return {
        artifacts: [
          {
            mediaType: 'video',
            storageRef,
          },
        ],
      };
    }

    throw new Error(`未实现的生成任务类型: ${taskType}`);
  };

  try {
    if (ctx?.signal) {
      return await Promise.race([executeCore(), createAbortListener()]);
    }
    return await executeCore();
  } catch (error) {
    throw normalizeGenerationError(error);
  }
}
