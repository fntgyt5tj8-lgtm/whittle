import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";

/** A menu opened at `x` stays inside the window, even for the last steps at the right end. */
export const menuLeft = (x: number) => Math.max(8, Math.min(x, window.innerWidth - 248));

/** An open menu closes on a click elsewhere, on Escape (before Escape means anything else) and when the window resizes. */
export function useMenuDismiss(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

export function HistoryControls({ end, count, setRollback }: {
  end: number;
  count: number;
  setRollback: (to: number) => void;
}) {
  return (
    <div className="timeline__controls">
      <button className="iconbtn" title="Go to start" aria-label="Roll back to start" onClick={() => setRollback(0)} disabled={count === 0}>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4 V16 M15 4 L8 10 L15 16" /></svg>
      </button>
      <button className="iconbtn" title="Step back" aria-label="Step back" onClick={() => setRollback(Math.max(0, end - 1))} disabled={end === 0}>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M13 4 L7 10 L13 16" /></svg>
      </button>
      <button className="iconbtn" title="Step forward" aria-label="Step forward" onClick={() => setRollback(end + 1)} disabled={end >= count}>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4 L13 10 L7 16" /></svg>
      </button>
      <button className="iconbtn" title="Go to end" aria-label="Go to end" onClick={() => setRollback(count)} disabled={end >= count}>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M15 4 V16 M5 4 L12 10 L5 16" /></svg>
      </button>
    </div>
  );
}

export function useHistoryMarker(end: number, setRollback: (to: number) => void) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const cleanup = useRef<() => void>(undefined);
  useEffect(() => () => cleanup.current?.(), []);

  function position(x: number) {
    const steps = [...(track.current?.querySelectorAll<HTMLElement>("[data-history-step]") ?? [])];
    const index = steps.findIndex((step) => {
      const rect = step.getBoundingClientRect();
      return x < rect.left + rect.width / 2;
    });
    const candidate = steps[index];
    if (candidate) return Number(candidate.dataset.historyIndex ?? index);
    const last = steps.at(-1);
    return last?.dataset.historyEnd === undefined ? steps.length : Number(last.dataset.historyEnd);
  }

  function startDrag(event: React.PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanup.current?.();
    const pointerId = event.pointerId;
    const move = (e: PointerEvent) => {
      if (e.pointerId === pointerId) setDrag(position(e.clientX));
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cleanup.current?.();
      setDrag(null);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cancel(e);
      setRollback(position(e.clientX));
    };
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  return { track, markerAt: drag ?? end, startDrag };
}

interface Action {
  run?: () => void;
  reason?: string;
}

export function HistoryMenu({ x, y, name, suppressed, actions, close, pickedCount = 0 }: {
  x: number;
  y: number;
  name: string;
  suppressed?: boolean;
  pickedCount?: number;
  actions: { paste?: Action } & Record<"edit" | "suppress" | "rename" | "earlier" | "later" | "copy" | "folder" | "rollback" | "delete", Action>;
  close: () => void;
}) {
  useMenuDismiss(true, close);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = menu.current;
    if (!node) return;
    node.style.left = `${Math.max(8, Math.min(x, window.innerWidth - node.offsetWidth - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(y - 8, window.innerHeight - 8) - node.offsetHeight)}px`;
  });
  const items: (readonly [keyof typeof actions, IconName, string])[] = [
    ["edit", "edit", "Edit"],
    ["suppress", "suppress", suppressed ? "Turn back on" : "Turn off (suppress)"],
    ["rename", "edit", "Rename"],
    ["earlier", "arrowLeft", "Move earlier"],
    ["later", "arrowRight", "Move later"],
    ["copy", "copy", pickedCount > 1 ? `Copy ${pickedCount} steps` : "Copy"],
    ...(actions.paste ? [["paste", "copy", "Paste"] as const] : []),
    ["folder", "folder", pickedCount > 1 ? `Put in a folder (${pickedCount} steps)` : "Put in a folder"],
    ["rollback", "rollback", "Roll back to before this"],
    ["delete", "trash", "Delete"],
  ];
  return (
    <div ref={menu} className="menu" style={{ transform: "none" }} role="menu" onPointerDown={(e) => e.stopPropagation()}>
      <div className="menu__title">{name}</div>
      {items.map(([key, icon, label]) => {
        const { run, reason } = actions[key]!;
        return (
          <button key={key} role="menuitem" className={key === "delete" ? "danger" : undefined}
            disabled={!run || !!reason} title={reason} onClick={() => { close(); run?.(); }}>
            <Icon name={icon} size={16} />
            <span className="menu__text">{label}{reason && <small>{reason}</small>}</span>
            {key === "rename" && <kbd>F2</kbd>}
          </button>
        );
      })}
    </div>
  );
}

/** A real slider (audit UI-6): focusable, with its value, and the arrow keys step it like the buttons do. */
export function Marker({ onDown, at, max, onStep, title = "Drag to roll the design back in time" }: { onDown: (e: React.PointerEvent) => void; at: number; max: number; onStep: (to: number) => void; title?: string }) {
  return (
    <span
      className="marker"
      onPointerDown={onDown}
      title={title}
      role="slider"
      tabIndex={0}
      aria-label="Timeline marker"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={at}
      aria-valuetext={`${at} of ${max} steps`}
      onKeyDown={(e) => {
        const to = e.key === "ArrowLeft" ? at - 1 : e.key === "ArrowRight" ? at + 1 : e.key === "Home" ? 0 : e.key === "End" ? max : null;
        if (to === null) return;
        e.preventDefault();
        e.stopPropagation();
        onStep(Math.max(0, Math.min(max, to)));
      }}
    />
  );
}
