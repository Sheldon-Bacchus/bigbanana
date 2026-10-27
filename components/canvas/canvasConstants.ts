import { MediaCanvasViewport } from '../../types';

export type CanvasMode = 'image' | 'video';
export type CanvasEntryMode = CanvasMode | 'all';

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 180;
export const REFERENCE_BUNDLE_HEIGHT = 240;
export const CONFIG_NODE_HEIGHT = 190;
export const ARTIFACT_NODE_HEIGHT = 190;
export const TASK_NODE_HEIGHT = 160;

export const WORLD_WIDTH = 2200;
export const WORLD_HEIGHT = 1500;

export const DEFAULT_VIEWPORT: MediaCanvasViewport = { x: 36, y: 32, zoom: 0.8 };

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export interface DragState {
  type: 'canvas' | 'node';
  nodeId?: string;
  startX: number;
  startY: number;
  startViewport?: MediaCanvasViewport;
  startNode?: { x: number; y: number };
}

export interface ConnectingState {
  sourceNodeId: string;
  sourceHandle: string;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}
