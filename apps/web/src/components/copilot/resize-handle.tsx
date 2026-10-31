import {
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";

import {
  COPILOT_SIDEBAR_DEFAULT_WIDTH,
  COPILOT_SIDEBAR_MAX_WIDTH,
  COPILOT_SIDEBAR_MIN_WIDTH,
  COPILOT_SIDEBAR_STORAGE_KEY,
  clampCopilotSidebarWidth,
  copilotSidebarWidthForKey,
} from "@/lib/assistant-sidebar-width";
import { SIDEBAR_ID } from "./context";

export function SidebarResizeHandle() {
  const widthRef = useRef(COPILOT_SIDEBAR_DEFAULT_WIDTH);
  const handleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  const applyWidth = useCallback((nextWidth: number, persist: boolean) => {
    const width = clampCopilotSidebarWidth(nextWidth);
    widthRef.current = width;
    document.documentElement.style.setProperty(
      "--northwind-copilot-sidebar-width",
      `${width}px`,
    );
    handleRef.current?.setAttribute("aria-valuenow", String(width));
    if (persist) {
      window.localStorage.setItem(COPILOT_SIDEBAR_STORAGE_KEY, String(width));
    }
  }, []);

  useLayoutEffect(() => {
    const stored = Number(window.localStorage.getItem(COPILOT_SIDEBAR_STORAGE_KEY));
    applyWidth(
      Number.isFinite(stored) && stored > 0
        ? stored
        : COPILOT_SIDEBAR_DEFAULT_WIDTH,
      false,
    );
    return () => {
      dragRef.current = null;
      document.body.classList.remove("northwind-copilot-resizing");
    };
  }, [applyWidth]);

  const finishDrag = (pointerId: number) => {
    if (dragRef.current?.pointerId !== pointerId) return;
    dragRef.current = null;
    document.body.classList.remove("northwind-copilot-resizing");
    window.localStorage.setItem(
      COPILOT_SIDEBAR_STORAGE_KEY,
      String(widthRef.current),
    );
  };

  return (
    <div
      ref={handleRef}
      role="separator"
      tabIndex={0}
      aria-label="Resize Northwind AI sidebar"
      aria-controls={SIDEBAR_ID}
      aria-orientation="vertical"
      aria-valuemin={COPILOT_SIDEBAR_MIN_WIDTH}
      aria-valuemax={COPILOT_SIDEBAR_MAX_WIDTH}
      aria-valuenow={COPILOT_SIDEBAR_DEFAULT_WIDTH}
      className="assistant-resize-handle"
      onDoubleClick={() => applyWidth(COPILOT_SIDEBAR_DEFAULT_WIDTH, true)}
      onKeyDown={(event) => {
        const next = copilotSidebarWidthForKey(widthRef.current, event.key);
        if (next === null) return;
        event.preventDefault();
        applyWidth(next, true);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: widthRef.current,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add("northwind-copilot-resizing");
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        applyWidth(drag.startWidth + drag.startX - event.clientX, false);
      }}
      onPointerUp={(event) => {
        finishDrag(event.pointerId);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => finishDrag(event.pointerId)}
      onLostPointerCapture={(event) => finishDrag(event.pointerId)}
    >
      <span aria-hidden="true" />
    </div>
  );
}
