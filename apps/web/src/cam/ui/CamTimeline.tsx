import { Fragment, useState } from "react";
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
      <div className="timeline__track" ref={track} role="list" aria-label="Part history">
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
                <button type="button" data-history-step className={`step step--${state} ${selected ? "is-selected" : ""} ${drop}`}
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
