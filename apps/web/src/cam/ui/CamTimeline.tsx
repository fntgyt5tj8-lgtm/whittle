import { Fragment, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import {
  activePlanEnd, addOperationFolder, deletePlannedOperation, getProcessPlan, movePlannedOperation, moveTimelineItems, pastePlannedOperations, planMoveProblem, rollBackPlan,
  type CamMachiningStage, type CamOperationFolder, type CamProcess, type CamProject, type TimelineDragSource, type TimelineDropTarget,
} from "@whittle/cam";
import { uid } from "@whittle/core";
import { toast, useApp } from "../../state/store";
import { camTimelineClipboard } from "../../state/steps";
import { Icon } from "../../ui/icons";
import { confirmDialog, promptDialog } from "../../state/dialogs";
import { Select } from "../../ui/controls";
import { HistoryControls, HistoryMenu, Marker, menuLeft, useHistoryMarker, useMenuDismiss } from "../../ui/HistoryBar";
import type { ToolpathStatus } from "../toolpathCache";
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

let clipboard: { session: number; setupId: string; copies: { operation: CamProcess; stage: CamMachiningStage }[] } | undefined;

export function CamTimeline({ project, selectedKey, setupId, toolpathStatus, select, save }: {
  project: CamProject;
  selectedKey?: string;
  setupId?: string;
  toolpathStatus: (id: string) => ToolpathStatus;
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
  const lastStep = steps.at(-1);
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
  const [drag, setDrag] = useState<{
    source: TimelineDragSource;
    hover?: { key: string; target: TimelineDropTarget; style: string };
  }>();

  const session = useApp((state) => state.camToolpathSession);
  const [selection, setSelection] = useState<{ setupId?: string; ids: string[] }>();
  const picked = selection?.setupId === setupId ? selection?.ids ?? [] : [];
  const [folderMenu, setFolderMenu] = useState<{ id: string; x: number; y: number }>();
  useMenuDismiss(!!folderMenu, () => setFolderMenu(undefined));
  const folders = project.operationFolders ?? [];
  const folderOf = new Map(folders.flatMap((folder) => folder.operationIds.map((id) => [id, folder] as const)));

  const selectedFolderOpen = selectedKey?.startsWith("process:") ? folderOf.get(selectedKey.slice(8))?.open : undefined;
  const selectedOperation = useRef<HTMLButtonElement>(null);
  const selectedIndex = steps.findIndex(({ operation }) => selectedKey === `process:${operation.id}`);
  const dragX = useRef<number | null>(null);
  const dragSource = drag?.source;

  useLayoutEffect(() => {
    if (track.current && selectedOperation.current) revealOperation(track.current, selectedOperation.current);
  }, [track, selectedKey, selectedIndex, selectedFolderOpen, setupId]);

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
    if (!strip || !dragSource) return;
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
  }, [track, dragSource, setupId]);

  function targets(id?: string) {
    const ids = id && !picked.includes(id) ? [id] : picked;
    return steps.filter(({ operation }) => ids.includes(operation.id));
  }

  function copy(id?: string) {
    const copies = targets(id).map(({ operation, entry }) => ({ operation: structuredClone(operation), stage: entry.stage }));
    if (!setupId || !copies.length) return toast("info", "Select an operation in the Manufacturing timeline to copy it.");
    clipboard = { session, setupId, copies };
    toast("info", "Operations copied. Use Ctrl+V or ⌘V to paste at the timeline marker.");
  }

  function paste() {
    if (clipboard?.session !== session || clipboard.setupId !== setupId) {
      return toast("info", "Copy an operation from this setup before pasting.");
    }
    const copies = clipboard.copies;
    let first: string | undefined;
    save((current) => {
      const setup = current.setups.find(({ id }) => id === setupId);
      if (!setup || copies.some(({ operation }) => !setup.contexts?.some(({ id }) => id === operation.contextId)
        || (operation.toolPositionId !== undefined && !current.toolPositions?.some(({ id }) => id === operation.toolPositionId)))) {
        return current;
      }
      const names = new Set(current.processes.map(({ name }) => name));
      const fresh = copies.map(({ operation, stage }) => {
        const stem = `${operation.name} copy`;
        let name = stem;
        for (let n = 2; names.has(name); n++) name = `${stem} ${n}`;
        names.add(name);
        return { stage, operation: { ...structuredClone(operation), id: uid(operation.kind), name } };
      });
      first = fresh[0]?.operation.id;
      return pastePlannedOperations(current, fresh);
    }, "Paste manufacturing operations");
    if (!first) return toast("info", "The copied operations need their original workpiece context and tool position.");
    setSelection(undefined);
    select(`process:${first}`);
  }

  useEffect(() => {
    const copySelection = () => copy(selectedKey?.startsWith("process:") ? selectedKey.slice(8) : undefined);
    camTimelineClipboard.copy = copySelection;
    camTimelineClipboard.paste = paste;
    return () => {
      if (camTimelineClipboard.copy === copySelection) {
        camTimelineClipboard.copy = undefined;
        camTimelineClipboard.paste = undefined;
      }
    };
  });

  async function putInFolder(id: string) {
    const operationIds = targets(id).map(({ operation }) => operation.id);
    const name = (await promptDialog({ title: "New operation folder", label: "Name",
      initial: `Folder ${folders.length + 1}`, confirmLabel: "Create" }))?.trim();
    if (!name || useApp.getState().camToolpathSession !== session) return;
    save((current) => {
      const members = current.processes.filter((operation) => operation.setupId === setupId && operationIds.includes(operation.id));
      return members.length ? addOperationFolder(current, { id: uid("camfolder"), name, open: false,
        operationIds: members.map(({ id }) => id) }) : current;
    }, "Create operation folder");
    setSelection(undefined);
  }

  function updateFolder(id: string, label: string, update: (folder: CamOperationFolder) => CamOperationFolder | undefined) {
    save((current) => ({
      ...current, operationFolders: current.operationFolders?.flatMap((folder) => {
        const next = folder.id === id ? update(folder) : folder;
        return next ? [next] : [];
      }),
    }), label);
  }

  async function renameFolder(folder: CamOperationFolder) {
    setFolderMenu(undefined);
    const name = (await promptDialog({ title: "Rename folder", label: "Name", initial: folder.name, confirmLabel: "Rename" }))?.trim();
    if (name && useApp.getState().camToolpathSession === session) {
      updateFolder(folder.id, "Rename operation folder", (current) => ({ ...current, name }));
    }
  }

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

  function startTimelineDrag(event: DragEvent, source: TimelineDragSource, name: string) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", name);
    setDrag({ source });
  }

  function dropOn(event: DragEvent, key: string, target: TimelineDropTarget) {
    if (!drag) return;
    event.stopPropagation();
    event.preventDefault();
    const hover = drag.hover;
    const sameTarget = hover?.key === key && hover.target.operationId === target.operationId
      && hover.target.side === target.side && hover.target.folderId === target.folderId;
    if (event.type !== "drop" && sameTarget) {
      event.dataTransfer.dropEffect = hover.style === "cam-drop--blocked" ? "none" : "move";
      return;
    }
    const allowed = moveTimelineItems(project, drag.source, target) !== project;
    if (event.type === "drop") {
      if (allowed) save((current) => moveTimelineItems(current, drag.source, target), "Move manufacturing timeline items");
      setDrag(undefined);
      return;
    }
    event.dataTransfer.dropEffect = allowed ? "move" : "none";
    const position = target.folderId && key.startsWith("folder:") ? "inside" : target.side;
    const style = allowed ? `cam-drop--${position}` : "cam-drop--blocked";
    setDrag({ source: drag.source, hover: { key, target, style } });
  }

  function dropStyle(key: string) {
    return drag?.hover?.key === key ? drag.hover.style : "";
  }

  function stepDrop(event: DragEvent<HTMLButtonElement>, id: string, folderId?: string) {
    // Whole folders use the enclosing folder's outer boundaries.
    if (folderId && drag && "folderId" in drag.source) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const side = event.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
    dropOn(event, `process:${id}`, { operationId: id, side, folderId });
  }

  function folderDrop(event: DragEvent<HTMLDivElement>, folder: CamOperationFolder, firstId: string, lastId: string) {
    if (!drag) return;
    const header = event.target instanceof Element ? event.target.closest("button.folder") : null;
    const bounds = (header ?? event.currentTarget).getBoundingClientRect();
    const fraction = (event.clientX - bounds.left) / bounds.width;
    const isFolder = "folderId" in drag.source;
    const edge = Math.min(0.25, 16 / bounds.width);
    const before = isFolder ? fraction < 0.5 : fraction < edge;
    const inside = !isFolder && !before && fraction <= 1 - edge;
    dropOn(event, `folder:${firstId}`, {
      operationId: before ? firstId : lastId,
      side: before ? "before" : "after",
      folderId: inside ? folder.id : undefined,
    });
  }

  function renderStep({ entry, operation, planIndex }: (typeof steps)[number], index: number, showMarker = true) {
    const { id } = operation;
    const key = `process:${id}`;
    const name = `${operation.name} · ${machiningLabels[entry.stage]}`;
    const state = planIndex >= planEnd ? "rolledback" : operation.suppressed ? "suppressed" : "ok";
    const pathStatus = toolpathStatus(id);
    const selected = selectedKey === key || (picked.length > 1 && picked.includes(id));
    const folder = folderOf.get(id);
    return (
      <Fragment key={key}>
        {showMarker && index === markerAt && marker}
        {(!folder || folder.open) && <div className="step-wrap" role="listitem">
          <button type="button" data-history-step ref={selectedKey === key ? selectedOperation : undefined} data-history-index={index} data-history-end={index + 1} className={`step step--${state} ${selected ? "is-selected" : ""} ${dropStyle(key)}`}
            aria-label={name} aria-pressed={selected} aria-description={`Toolpath ${pathStatus}`}
            title={`${name}${state === "ok" ? "" : state === "suppressed" ? " · Suppressed" : " · Rolled back"} · Toolpath ${pathStatus}\nDouble-click (or Enter) to edit · F2 to rename · drag, or Alt + arrow keys, to reorder`}
            onClick={(event) => {
              if (event.shiftKey) {
                const first = steps.findIndex(({ operation }) => `process:${operation.id}` === selectedKey);
                const range = first < 0 ? [id]
                  : steps.slice(Math.min(index, first), Math.max(index, first) + 1).map(({ operation }) => operation.id);
                setSelection({ setupId, ids: range });
              } else {
                setSelection(undefined);
                select(key);
              }
            }} onDoubleClick={() => select(key)}
            draggable
            onDragStart={(e) => startTimelineDrag(e, { operationId: id }, name)}
            onDragOver={(e) => stepDrop(e, id, folder?.id)}
            onDrop={(e) => stepDrop(e, id, folder?.id)}
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
            <span className={`cam-toolpath-dot cam-toolpath-dot--${pathStatus}`} aria-hidden="true" />
          </button>
        </div>}
        {menu?.key === key && <HistoryMenu x={menu.x} y={menu.y} name={operation.name}
          suppressed={operation.suppressed} pickedCount={targets(id).length} close={() => setMenu(undefined)} actions={{
            edit: { run: () => select(key) },
            suppress: { run: () => updateOperation(id, (current) => ({ ...current, suppressed: !current.suppressed }),
              operation.suppressed ? "Unsuppress manufacturing operation" : "Suppress manufacturing operation") },
            rename: { run: () => void rename(id) },
            earlier: moveAction(id, index - 1),
            later: moveAction(id, index + 1),
            copy: { run: () => copy(id) },
            paste: { run: paste, reason: clipboard?.session === session && clipboard.setupId === setupId
              ? undefined : "Copy an operation from this setup first." },
            folder: { run: () => void putInFolder(id) },
            rollback: { run: () => setRollback(planIndex) },
            delete: { run: () => void remove(id) },
          }} />}
      </Fragment>
    );
  }

  return (
    <>
      {project.setups.length > 0 && <Select className="cam-timeline__setup" size="sm" placement="top-start" allowReselect
        ariaLabel="Timeline setup" value={setupId} options={project.setups.map(({ id, name }) => ({ value: id, label: name }))}
        onChange={(id) => { setSelection(undefined); select(`setup:${id}`); }} />}
      <HistoryControls end={end} count={steps.length} setRollback={setVisibleRollback} />
      <div className="timeline__track cam-timeline__track" ref={track} role="list" aria-label="Part history"
        onKeyDown={(event) => {
          if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || menu || folderMenu) return;
          const strip = event.currentTarget;
          const items = [...strip.querySelectorAll<HTMLElement>('[data-history-step], button.folder, [role="slider"]')];
          const index = items.findIndex((item) => item === event.target);
          const next = items[index + (event.shiftKey ? -1 : 1)];
          if (index < 0 || !next?.hasAttribute("data-history-step")) return;
          event.preventDefault();
          next.focus({ preventScroll: true });
          revealOperation(strip, next);
        }}
        onDragOverCapture={(event) => { if (drag) dragX.current = event.clientX; }}
        onDragOver={() => { if (drag?.hover) setDrag({ source: drag.source }); }}
        onDragLeave={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          dragX.current = null;
          if (drag?.hover) setDrag({ source: drag.source });
        }}>
        {!project.setups.length && <span className="timeline__empty">Create a setup to start the part history.</span>}
        {steps.map((step, index) => {
          const { operation } = step;
          const folder = folderOf.get(operation.id);
          if (!folder) return renderStep(step, index);
          const previous = steps[index - 1];
          if (previous && folderOf.get(previous.operation.id) === folder) return null;

          let folderEnd = index + 1;
          while (true) {
            const next = steps[folderEnd];
            if (!next || folderOf.get(next.operation.id) !== folder) break;
            folderEnd++;
          }
          const children = steps.slice(index, folderEnd);
          const lastId = children.at(-1)?.operation.id ?? operation.id;
          return (
            <Fragment key={`process:${operation.id}`}>
              {index === markerAt && marker}
              <div className={`cam-timeline__folder ${folder.open ? "cam-timeline__folder--open" : ""} ${dropStyle(`folder:${operation.id}`)}`}
                role="group" aria-label={folder.name}
                onDragOver={(e) => folderDrop(e, folder, operation.id, lastId)}
                onDrop={(e) => folderDrop(e, folder, operation.id, lastId)}>
                <button type="button" className={`folder ${folder.open ? "is-open" : ""}`}
                  aria-expanded={folder.open} title={`${folder.name} · drag to move folder · drop an operation in the center to add it or at an edge to leave it outside · right-click to rename or ungroup`}
                  draggable
                  onDragStart={(e) => startTimelineDrag(e, { folderId: folder.id }, folder.name)}
                  onDragEnd={() => setDrag(undefined)}
                  data-history-step={folder.open ? undefined : ""}
                  data-history-index={index} data-history-end={folderEnd}
                  onClick={() => updateFolder(folder.id, folder.open ? "Fold operation folder" : "Open operation folder",
                    (current) => ({ ...current, open: !current.open }))}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setFolderMenu({ id: folder.id, x: event.clientX, y: event.clientY });
                  }}>
                  <Icon name="folder" size={16} /><span>{folder.name}</span>
                  <Icon name={folder.open ? "chevronDown" : "chevronRight"} size={14} />
                </button>
                {children.map((child, offset) => renderStep(child, index + offset, offset > 0))}
              </div>
            </Fragment>
          );
        })}
        {steps.length > 0 && markerAt === steps.length && marker}
        {drag && lastStep && <div className={`cam-timeline__drop-end ${dropStyle("end")}`} aria-hidden="true"
          onDragOver={(e) => dropOn(e, "end", { operationId: lastStep.operation.id, side: "after" })}
          onDrop={(e) => dropOn(e, "end", { operationId: lastStep.operation.id, side: "after" })} />}
      </div>
      {folderMenu && folders.filter(({ id }) => id === folderMenu.id).map((folder) => (
        <div key={folder.id} className="menu" style={{ left: menuLeft(folderMenu.x), top: folderMenu.y - 8 }}
          role="menu" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => void renameFolder(folder)}>
            <Icon name="edit" size={16} /> Rename
          </button>
          <button type="button" role="menuitem" onClick={() => {
            setFolderMenu(undefined);
            updateFolder(folder.id, "Ungroup operation folder", () => undefined);
          }}>
            <Icon name="unlink" size={16} /> Ungroup
          </button>
        </div>
      ))}
    </>
  );
}
