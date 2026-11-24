import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  activePlanEnd, deletePlannedOperation, getProcessPlan, movePlannedOperation, planMoveProblem, rollBackPlan,
  type CamProcess, type CamProject,
} from "@whittle/cam";
import { confirmDialog, promptDialog } from "../../state/dialogs";
import { Select } from "../../ui/controls";
import { HistoryControls, HistoryMenu, Marker, useHistoryMarker } from "../../ui/HistoryBar";
import { MillIcon } from "./icons/MillIcon";

export const machiningLabels = { main: "Main machining", sub: "Sub / back-working" };
export const stageLabels = { transfer: "Transfer", ejection: "Ejection" };

function revealOperation(track: HTMLDivElement, operation: HTMLElement) {
  const viewport = track.getBoundingClientRect();
  const bounds = operation.getBoundingClientRect();
  const left = viewport.left + track.clientLeft;
  const right = left + track.clientWidth;
  if (bounds.left < left) track.scrollLeft += bounds.left - left;
  else if (bounds.right > right) track.scrollLeft += bounds.right - right;
}

export function CamTimeline({ project, selectedKey, setupId, select, save }: {
  project: CamProject;
  selectedKey?: string;
  setupId?: string;
  select: (key: string) => void;
  save: (update: (current: CamProject) => CamProject, label: string) => void;
}) {
  const plan = getProcessPlan(project);
  const operations = new Map(project.processes.map((operation) => [operation.id, operation]));
  const steps = plan.flatMap((entry, planIndex) => {
    if (entry.kind !== "process") return [];
    const operation = operations.get(entry.processId);
    return operation && operation.setupId === setupId ? [{ entry, operation, planIndex }] : [];
  });
  const planEnd = activePlanEnd(project);
  const end = steps.filter(({ planIndex }) => planIndex < planEnd).length;
  const setRollback = (to: number) => save((current) => rollBackPlan(current, to), "Move manufacturing timeline marker");
  // The marker counts visible steps, while rollback is stored as a position in the full plan.
  function setVisibleRollback(to: number) {
    if (to === end) return;
    const last = steps.at(-1);
    if (last) setRollback(steps[to]?.planIndex ?? last.planIndex + 1);
  }
  const { track, markerAt, startDrag } = useHistoryMarker(end, setVisibleRollback);
  const marker = <Marker at={markerAt} max={steps.length} onDown={startDrag} onStep={setVisibleRollback} title="Drag to roll back the manufacturing plan" />;
  const [menu, setMenu] = useState<{ key: string; x: number; y: number }>();
  const [drag, setDrag] = useState<{ id: string; target: string }>();
  const selectedOperation = useRef<HTMLButtonElement>(null);
  const selectedIndex = steps.findIndex(({ operation }) => selectedKey === `process:${operation.id}`);
  const dragX = useRef<number | null>(null);
  const dragId = drag?.id;

  useLayoutEffect(() => {
    if (track.current && selectedOperation.current) revealOperation(track.current, selectedOperation.current);
  }, [track, selectedKey, selectedIndex, setupId]);

  useEffect(() => {
    const strip = track.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      const { deltaMode, deltaX, deltaY, ctrlKey, defaultPrevented } = event;
      // Let the browser handle horizontal gestures and pinch-to-zoom.
      if (ctrlKey || defaultPrevented || !deltaY || Math.abs(deltaX) >= Math.abs(deltaY)
        || (event.target instanceof Element && event.target.closest('[role="menu"]'))) return;
      const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? strip.clientWidth : 1;
      const before = strip.scrollLeft;
      const next = Math.max(0, Math.min(strip.scrollWidth - strip.clientWidth, before + deltaY * unit));
      if ((deltaY < 0 && next >= before) || (deltaY > 0 && next <= before) || !event.cancelable) return;
      event.preventDefault();
      strip.scrollLeft = next;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [track]);

  useEffect(() => {
    const strip = track.current;
    if (!strip || !dragId) return;
    let frame: number;
    let previousTime: number | undefined;
    const scrollAtEdge = (time: number) => {
      const elapsed = previousTime === undefined ? 0 : Math.min(time - previousTime, 32);
      previousTime = time;
      const x = dragX.current;
      if (x !== null && strip.scrollWidth > strip.clientWidth) {
        const left = strip.getBoundingClientRect().left + strip.clientLeft;
        const right = left + strip.clientWidth;
        const edge = Math.min(40, strip.clientWidth / 3);
        if (edge > 0 && x >= left && x <= right) {
          const pressure = x < left + edge ? (x - left) / edge - 1 : Math.max(0, 1 - (right - x) / edge);
          strip.scrollLeft += pressure * elapsed * 0.8;
        }
      }
      frame = requestAnimationFrame(scrollAtEdge);
    };
    frame = requestAnimationFrame(scrollAtEdge);
    return () => {
      cancelAnimationFrame(frame);
      dragX.current = null;
    };
  }, [track, dragId, setupId]);

  function updateOperation(id: string, update: (current: CamProcess) => CamProcess, label: string) {
    save((current) => {
      if (!current.processes.some((entry) => entry.id === id)) return current;
      return { ...current, processes: current.processes.map((entry) => entry.id === id ? update(entry) : entry) };
    }, label);
  }

  async function rename(id: string) {
    const operation = operations.get(id);
    if (!operation) return;
    const name = (await promptDialog({ title: "Rename operation", label: "Name", initial: operation.name, confirmLabel: "Rename" }))?.trim();
    if (name && name !== operation.name) updateOperation(id, (current) => ({ ...current, name }), "Rename manufacturing operation");
  }

  async function remove(id: string) {
    const operation = operations.get(id);
    if (operation && await confirmDialog({ title: "Delete operation", message: `Delete “${operation.name}”?`, confirmLabel: "Delete", danger: true })) {
      save((current) => deletePlannedOperation(current, id), "Delete manufacturing operation");
      if (selectedKey === `process:${id}`) select(`setup:${operation.setupId}`);
    }
  }

  function move(id: string, target: string) {
    save((current) => movePlannedOperation(current, id, target), "Reorder manufacturing operations");
  }

  function moveAction(id: string, index: number) {
    const target = steps[index]?.operation;
    if (!target) return { reason: "It's already at that end." };
    return { reason: planMoveProblem(project, id, target.id), run: () => move(id, target.id) };
  }

  return (
    <>
      {project.setups.length > 0 && <Select className="cam-timeline__setup" size="sm" placement="top-start" allowReselect
        ariaLabel="Timeline setup" value={setupId} options={project.setups.map(({ id, name }) => ({ value: id, label: name }))}
        onChange={(id) => select(`setup:${id}`)} />}
      <HistoryControls end={end} count={steps.length} setRollback={setVisibleRollback} />
      <div className="timeline__track cam-timeline__track" ref={track} role="list" aria-label="Part history"
        onKeyDown={(e) => {
          if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey || menu) return;
          const strip = e.currentTarget;
          const items = [...strip.querySelectorAll<HTMLElement>('[data-history-step], [role="slider"]')];
          const index = items.findIndex((item) => item === e.target);
          const next = items[index + (e.shiftKey ? -1 : 1)];
          if (index < 0 || !next?.hasAttribute("data-history-step")) return;
          // Chromium can center an offscreen button during native Tab navigation.
          e.preventDefault();
          next.focus({ preventScroll: true });
          revealOperation(strip, next);
        }}
        onDragOver={(e) => { if (drag) dragX.current = e.clientX; }}
        onDragLeave={(e) => {
          if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) dragX.current = null;
        }}>
        {!project.setups.length && <span className="timeline__empty">Create a setup to start the part history.</span>}
        {steps.map(({ entry, operation, planIndex }, index) => {
          const { id } = operation;
          const key = `process:${id}`;
          const name = `${operation.name} · ${machiningLabels[entry.stage]}`;
          const state = planIndex >= planEnd ? "rolledback" : operation.suppressed ? "suppressed" : "ok";
          const selected = selectedKey === key;
          const drop = drag && drag.id !== id && drag.target === id
            ? planMoveProblem(project, drag.id, id) ? "is-drop-blocked" : "is-drop-before" : "";
          return (
            <Fragment key={key}>
              {index === markerAt && marker}
              <div className="step-wrap" role="listitem">
                <button type="button" data-history-step ref={selected ? selectedOperation : undefined}
                  className={`step step--${state} ${selected ? "is-selected" : ""} ${drop}`}
                  aria-label={name} aria-pressed={selected}
                  title={`${name}${state === "ok" ? "" : state === "suppressed" ? " · Suppressed" : " · Rolled back"}\nDouble-click (or Enter) to edit · F2 to rename · drag, or Alt + arrow keys, to reorder`}
                  onClick={() => select(key)} onDoubleClick={() => select(key)}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", name);
                    setDrag({ id, target: id });
                  }}
                  onDragOver={(e) => {
                    if (!drag) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = planMoveProblem(project, drag.id, id) ? "none" : "move";
                    if (drag.target !== id) setDrag({ id: drag.id, target: id });
                  }}
                  onDrop={(e) => {
                    if (!drag) return;
                    e.preventDefault();
                    move(drag.id, id);
                    setDrag(undefined);
                  }}
                  onDragEnd={() => setDrag(undefined)}
                  onKeyDown={(e) => {
                    if (e.key === "F2") {
                      e.preventDefault();
                      e.stopPropagation();
                      void rename(id);
                    } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                      e.preventDefault();
                      e.stopPropagation();
                      const action = moveAction(id, index + (e.key === "ArrowLeft" ? -1 : 1));
                      if (!action.reason) action.run?.();
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ key, x: e.clientX, y: e.clientY });
                  }}>
                  <MillIcon size={18} />
                </button>
              </div>
              {menu?.key === key && <HistoryMenu x={menu.x} y={menu.y} name={operation.name}
                suppressed={operation.suppressed} close={() => setMenu(undefined)} actions={{
                  edit: { run: () => select(key) },
                  suppress: { run: () => updateOperation(id, (current) => ({ ...current, suppressed: !current.suppressed }),
                    operation.suppressed ? "Unsuppress manufacturing operation" : "Suppress manufacturing operation") },
                  rename: { run: () => void rename(id) },
                  earlier: moveAction(id, index - 1),
                  later: moveAction(id, index + 1),
                  copy: { reason: "CAM clipboard copying is unavailable." },
                  folder: { reason: "Manufacturing folders are unavailable." },
                  rollback: { run: () => setRollback(planIndex) },
                  delete: { run: () => void remove(id) },
                }} />}
            </Fragment>
          );
        })}
        {steps.length > 0 && markerAt === steps.length && marker}
      </div>
    </>
  );
}
