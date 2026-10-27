import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ListTodo,
  X,
  Play,
  RotateCcw,
  Ban,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Inbox,
  ChevronDown,
  ChevronUp,
  Activity,
  Layers,
  Sparkles,
} from 'lucide-react';
import { GenerationTaskEntity } from '../../types';
import taskCenterService from '../../services/taskCenterService';

export interface TaskCenterDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

type FilterTab = 'all' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

interface TabDefinition {
  key: FilterTab;
  label: string;
}

const TABS: TabDefinition[] = [
  { key: 'all', label: '全部' },
  { key: 'queued', label: '排队中' },
  { key: 'running', label: '生成中' },
  { key: 'succeeded', label: '已完成' },
  { key: 'failed', label: '失败' },
  { key: 'canceled', label: '已取消' },
];

/**
 * 格式化时间戳显示
 */
const formatTime = (timestamp?: number): string => {
  if (!timestamp) return '--';
  const d = new Date(timestamp);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

/**
 * 获取任务类型中文标签与样式
 */
const getTaskTypeBadge = (type: GenerationTaskEntity['taskType']) => {
  switch (type) {
    case 'text-to-image':
      return {
        label: '文生图',
        color: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
      };
    case 'image-to-video':
      return {
        label: '图生视频',
        color: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
      };
    case 'fl2v':
      return {
        label: '首尾帧视频',
        color: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
      };
    default:
      return {
        label: type,
        color: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
      };
  }
};

/**
 * 任务中心抽屉组件
 */
export const TaskCenterDrawer: React.FC<TaskCenterDrawerProps> = ({
  isOpen,
  onClose,
}) => {
  const [tasks, setTasks] = useState<GenerationTaskEntity[]>([]);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [expandedTaskIds, setExpandedTaskIds] = useState<Record<string, boolean>>({});
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const pointerDownOutsideRef = useRef(false);

  // 订阅任务中心状态更新（内置 1.5s 周期同步）
  useEffect(() => {
    const unsubscribe = taskCenterService.subscribe((updatedTasks) => {
      setTasks(updatedTasks);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // 监听 ESC 键关闭抽屉
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // 各状态计数
  const counts = useMemo(() => {
    const res: Record<FilterTab, number> = {
      all: tasks.length,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0,
    };
    for (const task of tasks) {
      if (task.status in res) {
        res[task.status as FilterTab]++;
      }
    }
    return res;
  }, [tasks]);

  // 按状态过滤任务
  const filteredTasks = useMemo(() => {
    if (activeTab === 'all') return tasks;
    return tasks.filter((t) => t.status === activeTab);
  }, [tasks, activeTab]);

  // 折叠与展开提示词详情
  const toggleExpand = (id: string) => {
    setExpandedTaskIds((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  // 取消任务
  const handleCancelTask = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await taskCenterService.cancelTask(id);
    } catch (err) {
      console.error('取消任务失败:', err);
    }
  };

  // 重试任务
  const handleRetryTask = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await taskCenterService.retryTask(id);
    } catch (err) {
      console.error('重试任务失败:', err);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[200] overflow-hidden"
      onPointerDown={(e) => {
        const targetNode = e.target as Node;
        pointerDownOutsideRef.current = drawerRef.current
          ? !drawerRef.current.contains(targetNode)
          : true;
      }}
      onPointerUp={(e) => {
        if (!pointerDownOutsideRef.current) return;
        const targetNode = e.target as Node;
        const isOutside = drawerRef.current
          ? !drawerRef.current.contains(targetNode)
          : true;
        pointerDownOutsideRef.current = false;
        if (isOutside) onClose();
      }}
      onPointerCancel={() => {
        pointerDownOutsideRef.current = false;
      }}
    >
      {/* 半透明遮罩 */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" />

      {/* 抽屉主容器 */}
      <div className="fixed inset-y-0 right-0 max-w-full flex pl-10 pointer-events-none">
        <div
          ref={drawerRef}
          className="pointer-events-auto w-screen max-w-md bg-[var(--bg-primary)] border-l border-[var(--border-primary)] shadow-2xl flex flex-col font-sans text-[var(--text-secondary)] animate-in slide-in-from-right duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 抽屉头部 */}
          <div className="p-4 border-b border-[var(--border-primary)] bg-[var(--bg-elevated)]/60 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-[var(--accent-bg)] border border-[var(--accent-border)] flex items-center justify-center">
                <ListTodo className="w-4 h-4 text-[var(--accent-text)]" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-[var(--text-primary)]">
                    任务中心
                  </h2>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-tertiary)]">
                    并发上限 2
                  </span>
                </div>
                <p className="text-[11px] text-[var(--text-muted)]">
                  全局后台生成队列与调度监控
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors"
              title="关闭 (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 实时调度状态条 */}
          <div className="px-4 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50 flex items-center justify-between text-xs">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1 text-[var(--text-tertiary)]">
                <Activity className="w-3.5 h-3.5 text-[var(--accent)]" />
                <span>运行中:</span>
                <strong className="text-[var(--text-primary)] font-mono">
                  {counts.running}/2
                </strong>
              </span>
              <span className="flex items-center gap-1 text-[var(--text-tertiary)]">
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                <span>排队中:</span>
                <strong className="text-[var(--text-primary)] font-mono">
                  {counts.queued}
                </strong>
              </span>
            </div>
            {counts.running >= 2 && (
              <span className="text-[10px] text-amber-400 font-medium animate-pulse">
                并发满载中
              </span>
            )}
          </div>

          {/* 分组筛选 Tabs */}
          <div className="flex px-3 pt-2 border-b border-[var(--border-primary)] bg-[var(--bg-primary)] overflow-x-auto no-scrollbar flex-shrink-0 gap-1">
            {TABS.map((tab) => {
              const count = counts[tab.key];
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-t-md transition-all whitespace-nowrap border-b-2 ${
                    isActive
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-bg)]/30 font-semibold'
                      : 'border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]'
                  }`}
                >
                  <span>{tab.label}</span>
                  <span
                    className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono leading-tight ${
                      isActive
                        ? 'bg-[var(--accent)] text-white'
                        : 'bg-[var(--bg-surface)] text-[var(--text-muted)]'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 任务列表区域 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {filteredTasks.length === 0 ? (
              <div className="h-64 flex flex-col items-center justify-center text-center p-6 rounded-xl border border-dashed border-[var(--border-primary)] bg-[var(--bg-secondary)]/30">
                <Inbox className="w-10 h-10 text-[var(--text-muted)] mb-2" />
                <p className="text-sm font-medium text-[var(--text-secondary)]">
                  暂无生成任务
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  当前分类下没有生成任务记录
                </p>
              </div>
            ) : (
              filteredTasks.map((task) => {
                const typeBadge = getTaskTypeBadge(task.taskType);
                const isExpanded = Boolean(expandedTaskIds[task.id]);

                return (
                  <div
                    key={task.id}
                    className="p-3.5 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-surface)]/80 hover:bg-[var(--bg-surface)] transition-all shadow-sm space-y-2.5"
                  >
                    {/* 卡片头部 */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-medium border ${typeBadge.color}`}
                        >
                          {typeBadge.label}
                        </span>
                        {task.promptPayload?.model && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-tertiary)]">
                            {task.promptPayload.model}
                          </span>
                        )}
                        <span className="text-[10px] font-mono text-[var(--text-muted)]">
                          {task.id.slice(0, 16)}
                        </span>
                      </div>

                      {/* 状态徽章 */}
                      <div className="flex-shrink-0">
                        {task.status === 'queued' && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30">
                            <Clock className="w-3 h-3" />
                            <span>排队中</span>
                          </span>
                        )}
                        {task.status === 'running' && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>生成中 {task.progress}%</span>
                          </span>
                        )}
                        {task.status === 'succeeded' && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>已完成</span>
                          </span>
                        )}
                        {task.status === 'failed' && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-rose-500/15 text-rose-400 border border-rose-500/30">
                            <XCircle className="w-3 h-3" />
                            <span>失败</span>
                          </span>
                        )}
                        {task.status === 'canceled' && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-500/15 text-slate-400 border border-slate-500/30">
                            <Ban className="w-3 h-3" />
                            <span>已取消</span>
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 进度条展示 */}
                    <div className="w-full">
                      <div className="flex items-center justify-between text-[10px] font-mono text-[var(--text-muted)] mb-1">
                        <span>进度</span>
                        <span>
                          {task.status === 'succeeded'
                            ? '100%'
                            : task.status === 'queued'
                            ? '0% (等待中)'
                            : `${task.progress || 0}%`}
                        </span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                        <div
                          className={`h-full transition-all duration-300 ${
                            task.status === 'succeeded'
                              ? 'bg-emerald-500'
                              : task.status === 'failed'
                              ? 'bg-rose-500'
                              : task.status === 'canceled'
                              ? 'bg-slate-500'
                              : task.status === 'running'
                              ? 'bg-[var(--accent)] animate-pulse'
                              : 'bg-amber-400'
                          }`}
                          style={{
                            width:
                              task.status === 'succeeded'
                                ? '100%'
                                : task.status === 'queued'
                                ? '0%'
                                : `${Math.max(task.progress || 0, 5)}%`,
                          }}
                        />
                      </div>
                    </div>

                    {/* 提示词内容与收折 */}
                    {task.promptPayload?.prompt && (
                      <div className="text-xs text-[var(--text-secondary)] bg-[var(--bg-secondary)]/60 rounded-lg p-2.5 border border-[var(--border-subtle)]">
                        <div
                          className={`font-sans leading-relaxed text-[11px] ${
                            isExpanded ? 'break-words' : 'line-clamp-2'
                          }`}
                        >
                          {task.promptPayload.prompt}
                        </div>
                        {task.promptPayload.prompt.length > 80 && (
                          <button
                            type="button"
                            onClick={() => toggleExpand(task.id)}
                            className="flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline mt-1 font-medium"
                          >
                            <span>{isExpanded ? '收起提示词' : '查看完整提示词'}</span>
                            {isExpanded ? (
                              <ChevronUp className="w-3 h-3" />
                            ) : (
                              <ChevronDown className="w-3 h-3" />
                            )}
                          </button>
                        )}
                      </div>
                    )}

                    {/* 错误信息展示 */}
                    {task.error && (
                      <div className="flex items-start gap-2 p-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-[11px] leading-tight">
                        <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                        <span className="break-words">{task.error}</span>
                      </div>
                    )}

                    {/* 卡片底栏与操作按钮 */}
                    <div className="flex items-center justify-between pt-1 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
                      <span title={`更新于: ${formatTime(task.updatedAt)}`}>
                        创建: {formatTime(task.createdAt)}
                      </span>

                      <div className="flex items-center gap-1.5">
                        {/* 排队或运行中的任务允许取消 */}
                        {(task.status === 'queued' || task.status === 'running') && (
                          <button
                            type="button"
                            onClick={(e) => handleCancelTask(task.id, e)}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-slate-300 hover:text-white bg-[var(--bg-elevated)] hover:bg-slate-700/60 border border-[var(--border-subtle)] transition-colors"
                            title="取消当前生成任务"
                          >
                            <Ban className="w-3 h-3 text-slate-400" />
                            <span>取消</span>
                          </button>
                        )}

                        {/* 失败或已取消的任务允许重试 */}
                        {(task.status === 'failed' || task.status === 'canceled') && (
                          <button
                            type="button"
                            onClick={(e) => handleRetryTask(task.id, e)}
                            className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium text-[var(--accent-text)] bg-[var(--accent-bg)] hover:brightness-110 border border-[var(--accent-border)] transition-all shadow-sm"
                            title="重置状态并重新排队执行"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>重试任务</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* 抽屉底部状态栏 */}
          <div className="p-3 border-t border-[var(--border-primary)] bg-[var(--bg-elevated)]/60 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>实时订阅中 (1.5s 周期巡检)</span>
            </span>
            <span className="font-mono">
              总计 {tasks.length} 项任务
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaskCenterDrawer;
