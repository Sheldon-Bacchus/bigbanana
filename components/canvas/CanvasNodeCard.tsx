import React from 'react';
import {
  ArrowRight,
  Camera,
  CheckCircle,
  Clock,
  Focus,
  Image as ImageIcon,
  Loader2,
  Sliders,
  Trash2,
  Video as VideoIcon,
} from 'lucide-react';
import { CanvasNodeEntity } from '../../types';
import { getNodeDimensions } from './canvasGraphUtils';

interface CanvasNodeCardProps {
  node: CanvasNodeEntity;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onOpenShot?: (shotId: string) => void;
  onUpdateData: (patch: Record<string, unknown>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onStartConnecting: (
    nodeId: string,
    handleId: string,
    event: React.PointerEvent<HTMLDivElement>
  ) => void;
}

const statusClass = (status: string) => {
  if (status === '已生成' || status === '镜头提示词已绑定' || status === 'succeeded') {
    return 'text-[var(--success-text)] border-[var(--success-border)] bg-[var(--success-bg)]';
  }
  if (status === '生成中' || status === 'running') {
    return 'text-[var(--warning-text)] border-[var(--warning-border)] bg-[var(--warning-bg)]';
  }
  if (status === '排队中' || status === 'queued') {
    return 'text-[var(--text-tertiary)] border-[var(--border-secondary)] bg-[var(--bg-hover)]';
  }
  if (status === '生成失败' || status === '缺少动作描述' || status === 'failed') {
    return 'text-[var(--error-text)] border-[var(--error-border)] bg-[var(--error-hover-bg)]';
  }
  return 'text-[var(--text-muted)] border-[var(--border-primary)] bg-[var(--bg-hover)]';
};

export const CanvasNodeCard: React.FC<CanvasNodeCardProps> = ({
  node,
  selected,
  onSelect,
  onDelete,
  onOpenShot,
  onUpdateData,
  onPointerDown,
  onStartConnecting,
}) => {
  const { width, height } = getNodeDimensions(node);
  const data = node.data || {};

  // 节点边框与主题样式映射
  const accentClass = (() => {
    switch (node.type) {
      case 'reference_slot':
        return 'border-amber-400/50 bg-amber-400/[0.06]';
      case 'config_node':
        return 'border-sky-400/50 bg-sky-400/[0.06]';
      case 'generation_task':
        return 'border-blue-400/50 bg-blue-400/[0.06]';
      case 'artifact_output':
        return data.mediaType === 'video'
          ? 'border-emerald-400/50 bg-emerald-400/[0.06]'
          : 'border-violet-400/50 bg-violet-400/[0.06]';
      case 'shot_projection':
      default:
        return 'border-[var(--border-secondary)] bg-[var(--bg-surface)]';
    }
  })();

  const typeIcon = () => {
    switch (node.type) {
      case 'reference_slot':
        return <Focus className="h-3.5 w-3.5 text-amber-400" />;
      case 'config_node':
        return <Sliders className="h-3.5 w-3.5 text-sky-400" />;
      case 'generation_task':
        return <Loader2 className="h-3.5 w-3.5 text-blue-400 animate-spin" />;
      case 'artifact_output':
        return data.mediaType === 'video' ? (
          <VideoIcon className="h-3.5 w-3.5 text-emerald-400" />
        ) : (
          <ImageIcon className="h-3.5 w-3.5 text-violet-400" />
        );
      case 'shot_projection':
      default:
        return <Camera className="h-3.5 w-3.5 text-[var(--accent-text)]" />;
    }
  };

  // 渲染插槽连线点
  const renderHandle = (
    handleId: string,
    handleType: 'input' | 'output',
    label: string,
    topPercent: string
  ) => (
    <div
      data-handle-id={handleId}
      data-node-id={node.id}
      data-handle-type={handleType}
      className={`group/handle absolute z-20 flex items-center justify-center -translate-y-1/2 cursor-crosshair ${
        handleType === 'input' ? '-left-2' : '-right-2'
      }`}
      style={{ top: topPercent }}
      onPointerDown={(event) => {
        if (handleType === 'output') {
          onStartConnecting(node.id, handleId, event);
        }
      }}
      title={`${handleType === 'output' ? '输出端 (拖动以连线)' : '输入插槽'}: ${label}`}
    >
      <div
        className={`h-3.5 w-3.5 rounded-full border-2 transition-transform duration-150 group-hover/handle:scale-125 shadow-sm ${
          handleType === 'output'
            ? 'border-emerald-400 bg-[var(--bg-elevated)] group-hover/handle:bg-emerald-400'
            : 'border-sky-400 bg-[var(--bg-elevated)] group-hover/handle:bg-sky-400'
        }`}
      />
    </div>
  );

  return (
    <div
      data-canvas-node="true"
      data-node-id={node.id}
      className={`absolute select-none rounded-xl border shadow-xl backdrop-blur-sm transition-shadow ${accentClass} ${
        selected ? 'ring-2 ring-[var(--accent)] shadow-[var(--accent-shadow)]' : ''
      }`}
      style={{
        left: node.position.x,
        top: node.position.y,
        width,
        height,
      }}
      onPointerDown={onPointerDown}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      {/* 输入插槽 (位于节点左侧，reference_slot 禁止入边) */}
      {node.type !== 'reference_slot' && (
        <>
          {renderHandle('slot-1', 'input', 'Slot 1 (参考/主输入)', '40%')}
          {(node.type === 'shot_projection' || node.type === 'config_node') &&
            renderHandle('slot-2', 'input', 'Slot 2 (附加配置/约束)', '68%')}
        </>
      )}

      {/* 输出插槽 (位于节点右侧，artifact_output 禁止出边) */}
      {node.type !== 'artifact_output' && (
        <>
          {node.type === 'shot_projection' ? (
            <>
              {renderHandle('output-image', 'output', '生图输出', '40%')}
              {renderHandle('output-video', 'output', '生视频输出', '68%')}
            </>
          ) : (
            renderHandle('output-image', 'output', '输出端', '50%')
          )}
        </>
      )}

      {/* 节点顶部标题栏 */}
      <div className="flex h-10 items-center gap-2 border-b border-[var(--border-primary)] bg-[var(--bg-elevated)]/90 px-3 rounded-t-xl">
        <span className="shrink-0">{typeIcon()}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-bold uppercase tracking-wider text-[var(--text-primary)]">
            {String(data.title || node.id)}
          </p>
          <p className="truncate text-[9px] font-mono text-[var(--text-muted)]">
            {String(data.subtitle || node.type)}
          </p>
        </div>

        {/* 状态徽标 */}
        {node.type === 'generation_task' && (
          <span
            className={`shrink-0 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[8px] font-mono ${statusClass(
              String(data.status || 'queued')
            )}`}
          >
            {data.status === 'running' ? (
              <>
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                生成中
              </>
            ) : data.status === 'succeeded' ? (
              <>
                <CheckCircle className="h-2.5 w-2.5 text-emerald-400" />
                已完成
              </>
            ) : (
              <>
                <Clock className="h-2.5 w-2.5" />
                排队中
              </>
            )}
          </span>
        )}

        {node.type === 'reference_slot' && (
          <span className="shrink-0 rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[8px] font-mono text-amber-300">
            {data.isBundle ? '资产包' : `槽位 #${data.slotNumber ?? 1}`}
          </span>
        )}

        {node.type !== 'generation_task' && node.type !== 'reference_slot' && data.status && (
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 text-[8px] font-mono ${statusClass(
              String(data.status)
            )}`}
          >
            {String(data.status)}
          </span>
        )}

        {/* 删除按钮 */}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:bg-[var(--error-hover-bg)] hover:text-[var(--error-text)] transition-colors"
          title="删除节点"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {/* 节点主体内容区 */}
      <div className="p-3">
        {/* 1. 分镜投影节点 */}
        {node.type === 'shot_projection' && (
          <div className="space-y-2">
            <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-base)] p-2 text-[10px] leading-relaxed text-[var(--text-secondary)] line-clamp-2">
              {String(data.actionSummary || '镜头动作摘要汇入此节点')}
            </div>
            {data.shotId && onOpenShot && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenShot(String(data.shotId));
                }}
                className="inline-flex items-center gap-1 rounded border border-[var(--accent-border)] bg-[var(--accent-bg)] px-2 py-1 text-[9px] font-bold text-[var(--accent-text)] hover:bg-[var(--accent-bg-strong)] transition-colors"
              >
                打开镜头工作台 <ArrowRight className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        {/* 2. 配置节点 (包含可编辑标题与 Prompt 文本框) */}
        {node.type === 'config_node' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-mono text-[var(--text-muted)]">提示词 (PROMPT)</span>
              <span className="text-[8px] text-[var(--text-tertiary)]">注入下游</span>
            </div>
            <textarea
              value={String(data.prompt || '')}
              onChange={(event) => onUpdateData({ prompt: event.target.value })}
              onKeyDown={(event) => event.stopPropagation()}
              placeholder="在此输入配置提示词、渲染风格或负向提示词..."
              rows={4}
              className="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-base)] p-2 text-[10px] leading-relaxed text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>
        )}

        {/* 3. 参考槽位节点 */}
        {node.type === 'reference_slot' && (
          <div className="space-y-2">
            {data.isBundle ? (
              <>
                <div className="grid grid-cols-4 gap-1">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div
                      key={index}
                      className="aspect-square overflow-hidden rounded border border-[var(--border-primary)] bg-[var(--bg-base)]"
                    >
                      {index === 0 && data.imageUrl ? (
                        <img
                          src={String(data.imageUrl)}
                          alt="参考资产"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-[9px] text-[var(--text-muted)]">
                          REF
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-[9px] leading-relaxed text-[var(--text-tertiary)]">
                  全局角色、场景与道具参考图，作为生图与生视频的上下文输入。
                </p>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-[var(--border-primary)] bg-[var(--bg-base)] flex items-center justify-center">
                  {data.imageUrl ? (
                    <img
                      src={String(data.imageUrl)}
                      alt="参考"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <Focus className="h-6 w-6 text-amber-400/40" />
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-[10px] font-bold text-amber-300">
                    参考槽位 #{data.slotNumber ?? 1}
                  </p>
                  <p className="text-[9px] text-[var(--text-tertiary)] leading-tight">
                    从右端拉线绑定至镜头的 Slot 1 / Slot 2。
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 4. 生成任务节点 */}
        {node.type === 'generation_task' && (
          <div className="space-y-2">
            <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-base)] p-2">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-[var(--text-secondary)] font-medium">任务排队中</span>
                <span className="font-mono text-[var(--text-muted)]">
                  {Number(data.progress || 0)}%
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-hover)]">
                <div
                  className="h-full bg-blue-400 transition-all duration-300"
                  style={{ width: `${Math.min(100, Math.max(0, Number(data.progress || 0)))}%` }}
                />
              </div>
            </div>
            <p className="text-[9px] text-[var(--text-tertiary)] truncate">
              {String(data.model || '标准扩散模型生成管道')}
            </p>
          </div>
        )}

        {/* 5. 产物输出卡片 */}
        {node.type === 'artifact_output' && (
          <div className="aspect-[16/9] overflow-hidden rounded-lg border border-[var(--border-primary)] bg-[var(--bg-base)] flex flex-col items-center justify-center">
            {data.videoUrl ? (
              <video
                src={String(data.videoUrl)}
                controls
                muted
                className="h-full w-full object-cover"
              />
            ) : data.imageUrl ? (
              <img
                src={String(data.imageUrl)}
                alt={String(data.title || '产物预览')}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-1 text-[10px] text-[var(--text-muted)]">
                {data.mediaType === 'video' ? (
                  <VideoIcon className="h-6 w-6 opacity-50 text-emerald-400" />
                ) : (
                  <ImageIcon className="h-6 w-6 opacity-50 text-violet-400" />
                )}
                <span className="font-mono text-[9px]">缩略图占位 / 待生成</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
