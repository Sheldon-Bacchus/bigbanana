import React from 'react';
import {
  CheckCircle,
  Focus,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  Sliders,
  Trash2,
  Video as VideoIcon,
  X,
} from 'lucide-react';
import { MediaCanvasViewport } from '../../types';
import { CanvasMode } from './canvasConstants';

interface CanvasToolbarProps {
  activeMode: CanvasMode;
  viewport: MediaCanvasViewport;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  hasSelection: boolean;
  onModeChange: (mode: CanvasMode) => void;
  onAddConfigNode: () => void;
  onAddReferenceSlot: () => void;
  onDeleteSelected: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetViewport: () => void;
  onClose: () => void;
}

export const CanvasToolbar: React.FC<CanvasToolbarProps> = ({
  activeMode,
  viewport,
  saveStatus,
  hasSelection,
  onModeChange,
  onAddConfigNode,
  onAddReferenceSlot,
  onDeleteSelected,
  onZoomIn,
  onZoomOut,
  onResetViewport,
  onClose,
}) => {
  return (
    <div className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--border-primary)] bg-[var(--bg-elevated)] px-6 z-30">
      {/* 头部标题与模式标识 */}
      <div className="flex min-w-0 items-center gap-3">
        <Maximize2 className="h-5 w-5 text-[var(--accent)] shrink-0" />
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold text-[var(--text-primary)]">
            无限生成画布
          </h2>
          <p className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-muted)]">
            INFINITE GENERATIVE CANVAS · INTERACTIVE
          </p>
        </div>

        {/* 保存状态提示 */}
        <div className="hidden sm:flex items-center gap-1.5 ml-2 rounded-full border border-[var(--border-primary)] bg-[var(--bg-base)] px-2.5 py-1 text-[10px] font-mono text-[var(--text-muted)]">
          {saveStatus === 'saving' ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin text-[var(--accent)]" />
              <span>存盘中...</span>
            </>
          ) : saveStatus === 'error' ? (
            <span className="text-[var(--error-text)]">存盘失败(保留本地)</span>
          ) : (
            <>
              <CheckCircle className="h-3 w-3 text-emerald-400" />
              <span>已存盘</span>
            </>
          )}
        </div>
      </div>

      {/* 中间操作按钮组：+ 配置节点 / + 参考槽位 / 删除选中项 */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onAddConfigNode}
          className="inline-flex items-center gap-1.5 rounded-lg border border-sky-400/40 bg-sky-400/10 px-3 py-1.5 text-[11px] font-medium text-sky-300 hover:bg-sky-400/20 active:scale-95 transition-all shadow-sm"
          title="在视口中心新建独立提示词/参数配置卡片"
        >
          <Sliders className="h-3.5 w-3.5" />
          <span>+ 配置节点</span>
        </button>

        <button
          type="button"
          onClick={onAddReferenceSlot}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-[11px] font-medium text-amber-300 hover:bg-amber-400/20 active:scale-95 transition-all shadow-sm"
          title="在视口中心新建资产参考槽位卡片"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>+ 参考槽位</span>
        </button>

        {hasSelection && (
          <button
            type="button"
            onClick={onDeleteSelected}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--error-border)] bg-[var(--error-hover-bg)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--error-text)] hover:opacity-90 active:scale-95 transition-all"
            title="删除选中的节点或连线 (Delete 键)"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>删除选中项</span>
          </button>
        )}
      </div>

      {/* 右侧控制：画布模式切换 / 视口缩放 / 关闭 */}
      <div className="flex items-center gap-2">
        {/* 生图/生视频模式切换器 */}
        <div className="flex items-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-surface)] p-1">
          <button
            type="button"
            onClick={() => onModeChange('image')}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
              activeMode === 'image'
                ? 'bg-[var(--accent-bg)] text-[var(--accent-text)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <ImageIcon className="h-3.5 w-3.5" />
            生图画布
          </button>
          <button
            type="button"
            onClick={() => onModeChange('video')}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
              activeMode === 'video'
                ? 'bg-[var(--accent-bg)] text-[var(--accent-text)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <VideoIcon className="h-3.5 w-3.5" />
            生视频画布
          </button>
        </div>

        {/* 缩放按钮 */}
        <div className="flex items-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-surface)]">
          <button
            type="button"
            onClick={onZoomOut}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            title="缩小"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="w-11 text-center font-mono text-[10px] text-[var(--text-muted)] select-none">
            {Math.round(viewport.zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={onZoomIn}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            title="放大"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 视口重置 */}
        <button
          type="button"
          onClick={onResetViewport}
          className="rounded-lg border border-[var(--border-primary)] p-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors"
          title="重置视口居中"
        >
          <Focus className="h-3.5 w-3.5" />
        </button>

        {/* 关闭按钮 */}
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-[var(--border-primary)] p-2 text-[var(--text-tertiary)] hover:bg-[var(--error-hover-bg)] hover:text-[var(--error-text)] transition-colors ml-1"
          title="关闭无限画布"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};
