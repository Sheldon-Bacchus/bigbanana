import React from 'react';
import { CanvasEdgeEntity, CanvasNodeEntity } from '../../types';
import { ConnectingState, WORLD_HEIGHT, WORLD_WIDTH } from './canvasConstants';
import { calculateHandlePosition } from './canvasGraphUtils';

interface CanvasEdgeLayerProps {
  edges: CanvasEdgeEntity[];
  nodeMap: Map<string, CanvasNodeEntity>;
  selectedEdgeId: string | null;
  connectingState: ConnectingState | null;
  onSelectEdge: (edgeId: string) => void;
  onDeleteEdge: (edgeId: string) => void;
}

export const CanvasEdgeLayer: React.FC<CanvasEdgeLayerProps> = ({
  edges,
  nodeMap,
  selectedEdgeId,
  connectingState,
  onSelectEdge,
  onDeleteEdge,
}) => {
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`}
      aria-hidden="true"
    >
      <defs>
        {/* 常规连线箭头 */}
        <marker
          id="canvas-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--border-secondary)" />
        </marker>

        {/* 选中高亮连线箭头 */}
        <marker
          id="canvas-arrow-selected"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--accent)" />
        </marker>
      </defs>

      {/* 渲染所有已确立的连线 */}
      {edges.map((edge) => {
        const sourceNode = nodeMap.get(edge.sourceNodeId);
        const targetNode = nodeMap.get(edge.targetNodeId);
        if (!sourceNode || !targetNode) return null;

        const start = calculateHandlePosition(sourceNode, edge.sourceHandle, 'output');
        const end = calculateHandlePosition(targetNode, edge.targetHandle, 'input');

        const control = Math.max(50, Math.abs(end.x - start.x) * 0.45);
        const pathData = `M ${start.x} ${start.y} C ${start.x + control} ${start.y}, ${
          end.x - control
        } ${end.y}, ${end.x} ${end.y}`;

        const isSelected = selectedEdgeId === edge.id;
        const midX = (start.x + end.x) / 2;
        const midY = (start.y + end.y) / 2;

        return (
          <g key={edge.id} className="group/edge">
            {/* 宽容度极高的隐形热区路径，方便鼠标点选连线 */}
            <path
              d={pathData}
              fill="none"
              stroke="transparent"
              strokeWidth="20"
              className="pointer-events-auto cursor-pointer"
              onClick={(event) => {
                event.stopPropagation();
                onSelectEdge(edge.id);
              }}
            />

            {/* 可视贝塞尔连线 */}
            <path
              d={pathData}
              fill="none"
              stroke={isSelected ? 'var(--accent)' : 'var(--border-secondary)'}
              strokeWidth={isSelected ? '3' : '2'}
              strokeDasharray={isSelected ? undefined : '5 5'}
              opacity={isSelected ? '1' : '0.8'}
              markerEnd={isSelected ? 'url(#canvas-arrow-selected)' : 'url(#canvas-arrow)'}
              className="transition-all duration-150"
            />

            {/* 选中状态下在中点渲染删除小按钮 */}
            {isSelected && (
              <g
                transform={`translate(${midX}, ${midY})`}
                className="pointer-events-auto cursor-pointer"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteEdge(edge.id);
                }}
              >
                <circle
                  r="9"
                  fill="var(--bg-elevated)"
                  stroke="var(--error-border)"
                  strokeWidth="1.5"
                  className="hover:scale-110 transition-transform"
                />
                <line
                  x1="-3.5"
                  y1="-3.5"
                  x2="3.5"
                  y2="3.5"
                  stroke="var(--error-text)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <line
                  x1="3.5"
                  y1="-3.5"
                  x2="-3.5"
                  y2="3.5"
                  stroke="var(--error-text)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </g>
            )}
          </g>
        );
      })}

      {/* 实时拖拽中的半成品连线指示 */}
      {connectingState && (
        <path
          d={`M ${connectingState.startX} ${connectingState.startY} C ${
            connectingState.startX + Math.max(50, Math.abs(connectingState.currentX - connectingState.startX) * 0.45)
          } ${connectingState.startY}, ${
            connectingState.currentX - Math.max(50, Math.abs(connectingState.currentX - connectingState.startX) * 0.45)
          } ${connectingState.currentY}, ${connectingState.currentX} ${connectingState.currentY}`}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
          strokeDasharray="6 4"
          markerEnd="url(#canvas-arrow-selected)"
          className="opacity-90"
        />
      )}
    </svg>
  );
};
