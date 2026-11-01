import type { MutableRefObject, ReactElement } from 'react';
import Button from '@cutucircuits/ui/button';
import { ContextMenu, MenuItem } from '@cutucircuits/ui/menu';
import Tooltip from '@cutucircuits/ui/tooltip';
import type { HoverContent } from '../circuit/circuitJson.ts';

export interface DirectViewerControls {
  fitToView: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

export type DirectViewerControlsRef =
  MutableRefObject<DirectViewerControls | null>;

export function ViewerCanvasControls({
  controlsRef,
}: {
  controlsRef: DirectViewerControlsRef;
}) {
  return (
    <div
      className="es-canvas-controls"
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Tooltip content="Zoom out">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Zoom out"
          onClick={() => controlsRef.current?.zoomOut()}
        >
          −
        </Button>
      </Tooltip>
      <Tooltip content="Fit to view">
        <Button
          variant="ghost"
          size="sm"
          className="es-canvas-fit"
          aria-label="Fit to view"
          onClick={() => controlsRef.current?.fitToView()}
        >
          <span aria-hidden="true">⤢</span> Fit
        </Button>
      </Tooltip>
      <Tooltip content="Zoom in">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Zoom in"
          onClick={() => controlsRef.current?.zoomIn()}
        >
          +
        </Button>
      </Tooltip>
    </div>
  );
}

export function ViewerContextMenu({
  trigger,
  controlsRef,
  onClearSelection,
}: {
  trigger: ReactElement;
  controlsRef: DirectViewerControlsRef;
  onClearSelection: () => void;
}) {
  return (
    <ContextMenu trigger={trigger}>
      <MenuItem onClick={() => controlsRef.current?.fitToView()}>
        Fit to view
      </MenuItem>
      <MenuItem onClick={() => controlsRef.current?.zoomIn()}>Zoom in</MenuItem>
      <MenuItem onClick={() => controlsRef.current?.zoomOut()}>
        Zoom out
      </MenuItem>
      <MenuItem onClick={onClearSelection}>Clear selection</MenuItem>
    </ContextMenu>
  );
}

export function ViewerPlaceholder({
  title,
  hint,
}: {
  title: string;
  hint: string;
}) {
  return (
    <div className="es-placeholder">
      <div className="es-placeholder-title">{title}</div>
      <div className="es-placeholder-hint">{hint}</div>
    </div>
  );
}

export interface ViewerHover {
  x: number;
  y: number;
  content: HoverContent;
}

export function ViewerHoverTooltip({ hover }: { hover: ViewerHover }) {
  return (
    <div
      className={`es-hover es-hover-${hover.content.kind}`}
      style={{ left: hover.x, top: hover.y }}
    >
      <div className="es-hover-title">{hover.content.title}</div>
      {hover.content.rows.map((row, index) => (
        <div className="es-hover-row" key={index}>
          {row.label && <span className="es-hover-k">{row.label}</span>}
          <span className="es-hover-v">{row.value}</span>
        </div>
      ))}
    </div>
  );
}
