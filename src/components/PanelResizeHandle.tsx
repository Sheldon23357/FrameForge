import { useEffect, useRef, useState, type RefObject } from 'react';

type Widths = { library: number; agent: number; inspector: number };
type Panel = keyof Widths;
const key = 'frameforge.panel-widths.v1';
const defaults: Widths = { library: 236, agent: 380, inspector: 304 };
const minimum: Widths = { library: 190, agent: 280, inspector: 240 };
const maximum: Widths = { library: 640, agent: 640, inspector: 600 };
function readWidths(): Widths {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    return Object.fromEntries(
      Object.entries(defaults).map(([k, d]) => [
        k,
        typeof value[k] === 'number' && Number.isFinite(value[k])
          ? Math.max(180, Math.min(640, value[k]))
          : d,
      ]),
    ) as Widths;
  } catch {
    return defaults;
  }
}
export function usePanelWidths(
  ref: RefObject<HTMLDivElement | null>,
  {
    ready,
    canvas,
    agentOpen,
    libraryOpen,
    inspectorOpen,
  }: {
    ready: boolean;
    canvas: boolean;
    agentOpen: boolean;
    libraryOpen: boolean;
    inspectorOpen: boolean;
  },
) {
  const [widths, setWidths] = useState(readWidths);
  const [total, setTotal] = useState(window.innerWidth);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTotal(entry.contentRect.width));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ref, ready]);
  const rail = total > 1700 ? 66 : total <= 800 ? 44 : total <= 1050 ? 50 : total <= 1250 ? 54 : 62;
  const stackLibrary = canvas && agentOpen && libraryOpen && total <= 1050;
  const separateLibrary = canvas && libraryOpen && !stackLibrary;
  const agentMin = agentOpen ? minimum.agent : 0;
  const inspectorMin = inspectorOpen ? minimum.inspector : 0;
  const libraryMin = separateLibrary ? minimum.library : 0;
  const room = Math.max(agentMin + inspectorMin + libraryMin, total - rail - 280);
  const inspector = inspectorOpen
    ? Math.max(
        inspectorMin,
        Math.min(widths.inspector, maximum.inspector, room - agentMin - libraryMin),
      )
    : 0;
  const agent = agentOpen
    ? Math.max(agentMin, Math.min(widths.agent, maximum.agent, room - inspector - libraryMin))
    : 0;
  const library = separateLibrary
    ? Math.max(libraryMin, Math.min(widths.library, maximum.library, room - inspector - agent))
    : 0;
  const remaining = room - agent - library - inspector;
  const update = (panel: Panel, value: number, persist = false) => {
    setWidths((old) => {
      const next = {
        ...old,
        [panel]: Math.round(Math.max(minimum[panel], Math.min(value, maximum[panel]))),
      };
      if (persist)
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* UI resizing still works when storage is full. */
        }
      return next;
    });
  };
  function resizeProps(panel: Panel, width: number) {
    return {
      width,
      min: minimum[panel],
      max: Math.min(maximum[panel], width + remaining),
      onResize: (value: number, persist: boolean) => update(panel, value, persist),
      onReset: () => update(panel, defaults[panel], true),
    };
  }
  return {
    stackLibrary,
    agent: resizeProps('agent', agent),
    library: resizeProps('library', library),
    inspector: resizeProps('inspector', inspector),
  };
}
export function PanelResizeHandle({
  side,
  label,
  width,
  min,
  max,
  onResize,
  onReset,
}: {
  side: 'left' | 'right';
  label: string;
  width: number;
  min: number;
  max: number;
  onResize(value: number, persist: boolean): void;
  onReset(): void;
}) {
  const drag = useRef<{ x: number; width: number; max: number; value: number } | null>(null);
  useEffect(() => () => document.body.classList.remove('resizing-panels'), []);
  return (
    <div
      className={`panel-resize-handle ${side}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={Math.max(min, Math.floor(max))}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="拖动调整宽度；双击恢复默认"
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width, max, value: width };
        document.body.classList.add('resizing-panels');
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const value = Math.max(
          min,
          Math.min(
            drag.current.max,
            drag.current.width + (e.clientX - drag.current.x) * (side === 'left' ? 1 : -1),
          ),
        );
        drag.current.value = value;
        onResize(value, false);
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        if (drag.current.x !== e.clientX || drag.current.width !== drag.current.value)
          onResize(drag.current.value, true);
        drag.current = null;
        document.body.classList.remove('resizing-panels');
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        document.body.classList.remove('resizing-panels');
      }}
      onKeyDown={(e) => {
        if (e.key === 'Home') {
          e.preventDefault();
          onReset();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const step = (e.key === 'ArrowRight' ? 16 : -16) * (side === 'left' ? 1 : -1);
          const value = Math.max(min, Math.min(max, width + step));
          if (value !== width) onResize(value, true);
        }
      }}
    />
  );
}
