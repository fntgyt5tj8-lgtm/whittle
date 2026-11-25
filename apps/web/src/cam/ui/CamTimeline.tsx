import { Fragment, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import {
  activePlanEnd, addOperationFolder, deletePlannedOperation, executionTracks, executionTrackId, getProcessPlan, movePlannedOperation, moveTimelineItems, pastePlannedOperations, planMoveProblem, rollBackPlan,
  type CamExecutionTrack, type CamMachiningStage, type CamOperationFolder, type CamProcess, type CamProject, type TimelineDragSource, type TimelineDropTarget,
} from "@whittle/cam";
import { uid } from "@whittle/core";
import { toast, useApp } from "../../state/store";
import { camTimelineActions } from "../../state/steps";
import { Icon } from "../../ui/icons";
import { confirmDialog, promptDialog } from "../../state/dialogs";
import { Popover, Select } from "../../ui/controls";
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

type Strategy = {
  id: string;
  name: string;
  label: string;
  enabled: boolean;
  add: (target: TimelineDropTarget) => string | undefined;
};
type DragSource = TimelineDragSource | { strategyId: string };
const contextInstructions = ["Tool", "Spindle", "Coolant", "Approach", "Retract", "Correction"];

let clipboard: { session: number; setupId: string; copies: { operation: CamProcess; stage: CamMachiningStage; trackId?: string }[] } | undefined;

export function CamTimeline({ project, selectedKey, setupId, strategies, createSetup, generateAll, generationDisabled, generationProgress, toolpathStatus, select, save }: {
  project: CamProject;
  selectedKey?: string;
  setupId?: string;
  strategies: Strategy[];
  createSetup: () => void;
  generateAll: () => void;
  generationDisabled: boolean;
  generationProgress?: string;
  toolpathStatus: (id: string) => ToolpathStatus;
  select: (key: string) => void;
  save: (update: (current: CamProject) => CamProject, label: string) => void;
}) {
  const setup = project.setups.find(({ id }) => id === setupId);
  const tracks = setup ? executionTracks(setup) : [];
  const plan = getProcessPlan(project);
  const operations = new Map(project.processes.map((operation) => [operation.id, operation]));
  const steps = plan.flatMap((entry, planIndex) => {
    if (entry.kind !== "process") return [];
    const operation = operations.get(entry.processId);
    return setup && operation?.setupId === setup.id
      ? [{ entry, operation, planIndex, trackId: executionTrackId(setup, entry.trackId) }] : [];
  });
  const planEnd = activePlanEnd(project);
  const [activeTracks, setActiveTracks] = useState(new Map<string, string>());
  const [positions, setPositions] = useState(new Map<string, { nextId?: string; index: number }>());
  const activeTrackId = setup && executionTrackId(setup, activeTracks.get(setup.id));
  const activeRow = steps.filter((step) => step.trackId === activeTrackId);
  const positionKey = (trackId: string) => JSON.stringify([setupId, trackId]);
  const remembered = activeTrackId ? positions.get(positionKey(activeTrackId)) : undefined;
  // Anchor the cursor to the next tile so insertion and reordering keep its intended boundary.
  const nextIndex = remembered?.nextId ? activeRow.findIndex(({ operation }) => operation.id === remembered.nextId) : -1;
  let end = activeRow.length;
  if (!remembered) end = activeRow.filter(({ planIndex }) => planIndex < planEnd).length;
  else if (remembered.nextId) end = nextIndex < 0 ? Math.min(remembered.index, activeRow.length) : nextIndex;

  function activateTrack(id: string) {
    if (!setupId || id === activeTrackId) return;
    if (activeTrackId && !remembered) rememberPosition(activeTrackId, activeRow, end);
    setActiveTracks((current) => new Map(current).set(setupId, id));
  }

  function rememberPosition(trackId: string, row: typeof steps, index: number) {
    const nextId = row[index]?.operation.id;
    setPositions((current) => new Map(current).set(positionKey(trackId), { nextId, index }));
  }

  function planBoundary(row: typeof steps, index: number) {
    return row[index]?.planIndex ?? (row.at(-1)?.planIndex ?? plan.length - 1) + 1;
  }

  function navigate(trackId: string, row: typeof steps, index: number) {
    activateTrack(trackId);
    rememberPosition(trackId, row, index);
    const boundary = planBoundary(row, index);
    save((current) => rollBackPlan(current, boundary), "Move manufacturing timeline marker");
  }

  const history = useRef<HTMLDivElement>(null);
  const markerFocus = useRef(false);
  const insertionTile = useRef<HTMLButtonElement>(null);
  const revealInsertion = useRef(false);
  function setVisibleRollback(to: number) {
    if (!activeTrackId || !activeRow.length) return;
    revealInsertion.current = to !== end;
    markerFocus.current = to !== end && history.current?.querySelector('[role="slider"]') === document.activeElement;
    navigate(activeTrackId, activeRow, to);
  }

  const { track, markerAt, startDrag } = useHistoryMarker(end, setVisibleRollback);
  const [paletteAnchor, setPaletteAnchor] = useState<HTMLButtonElement | null>(null);
  const paletteClose = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!paletteAnchor) return;
    const frame = requestAnimationFrame(() => paletteClose.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [paletteAnchor]);

  useEffect(() => setPaletteAnchor(null), [setupId, activeTrackId, markerAt]);

  function closePalette() {
    setPaletteAnchor(null);
  }

  const [hoveredOperationId, setHoveredOperationId] = useState<string>();
  const [focusedOperationId, setFocusedOperationId] = useState<string>();
  const [menu, setMenu] = useState<{ key: string; x: number; y: number }>();
  const [drag, setDrag] = useState<{
    source: DragSource;
    hover?: { key: string; target: TimelineDropTarget; style: string };
  }>();

  const session = useApp((state) => state.camToolpathSession);
  const [selection, setSelection] = useState<{ setupId?: string; ids: string[]; anchor?: string }>();
  const picked = selection?.setupId === setupId ? selection?.ids ?? [] : [];
  const pickedIds = new Set(picked.filter((id) => operations.has(id)));

  function selectStep(id: string, trackId: string, event?: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) {
    activateTrack(trackId);
    const anchor = selection?.setupId === setupId ? selection?.anchor : undefined;
    if (event?.shiftKey) {
      const row = steps.filter((step) => step.trackId === trackId);
      const from = row.findIndex(({ operation }) => operation.id === anchor);
      const to = row.findIndex(({ operation }) => operation.id === id);
      const first = from < 0 ? to : from;
      const ids = row.slice(Math.min(first, to), Math.max(first, to) + 1).map(({ operation }) => operation.id);
      setSelection({ setupId, ids, anchor: row[first]?.operation.id });
    } else if (event?.metaKey || event?.ctrlKey) {
      const ids = pickedIds.has(id) ? picked.filter((item) => item !== id) : [...pickedIds, id];
      setSelection({ setupId, ids, anchor: id });
    } else {
      setSelection({ setupId, ids: [id], anchor: id });
      select(`process:${id}`);
    }
  }
  const [folderMenu, setFolderMenu] = useState<{ id: string; x: number; y: number }>();
  useMenuDismiss(!!folderMenu, () => setFolderMenu(undefined));
  const folders = project.operationFolders ?? [];
  const folderOf = new Map(folders.flatMap((folder) => folder.operationIds.map((id) => [id, folder] as const)));

  const previewStep = steps.find(({ operation }) => operation.id === (hoveredOperationId ?? focusedOperationId)
    && folderOf.get(operation.id)?.open !== false);
  const previewState = previewStep && (previewStep.planIndex >= planEnd ? " · Rolled back"
    : previewStep.operation.suppressed ? " · Suppressed" : "");

  const selectedFolderOpen = selectedKey?.startsWith("process:") ? folderOf.get(selectedKey.slice(8))?.open : undefined;
  const selectedOperation = useRef<HTMLButtonElement>(null);
  const selectedIndex = steps.findIndex(({ operation }) => selectedKey === `process:${operation.id}`);
  const dragPointer = useRef<{ x: number; strip: HTMLDivElement } | null>(null);
  const dragSource = drag?.source;

  useLayoutEffect(() => {
    const operation = selectedOperation.current;
    const strip = operation?.closest<HTMLDivElement>(".cam-timeline__track");
    if (strip && operation) revealOperation(strip, operation);
  }, [selectedKey, selectedIndex, selectedFolderOpen, setupId, steps[selectedIndex]?.trackId]);

  useLayoutEffect(() => {
    if (markerFocus.current) {
      markerFocus.current = false;
      history.current?.querySelector<HTMLElement>('[role="slider"]')?.focus();
    }
    if (revealInsertion.current) {
      revealInsertion.current = false;
      const tile = insertionTile.current;
      const strip = tile?.closest<HTMLDivElement>(".cam-timeline__track");
      if (tile && strip) revealOperation(strip, tile);
    }
  }, [end, activeTrackId]);

  useEffect(() => {
    const container = history.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      const strip = event.target instanceof Element && event.target.closest<HTMLDivElement>(".cam-timeline__track");
      if (!strip) return;
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
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    if (!dragSource) return;
    let frame: number;
    let previousTime: number | undefined;
    const scrollAtEdge = (time: number) => {
      const elapsed = previousTime === undefined ? 0 : Math.min(time - previousTime, 32);
      previousTime = time;
      const pointer = dragPointer.current;
      if (pointer && pointer.strip.scrollWidth > pointer.strip.clientWidth) {
        const { x, strip } = pointer;
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
      dragPointer.current = null;
    };
  }, [dragSource, setupId]);

  function targets(id?: string) {
    const ids = id && !pickedIds.has(id) ? [id] : picked;
    return steps.filter(({ operation }) => ids.includes(operation.id));
  }

  function copy(id?: string) {
    const copies = targets(id).map(({ operation, entry, trackId }) => ({ operation: structuredClone(operation), stage: entry.stage, trackId }));
    if (!setupId || !copies.length) return toast("info", "Select an operation in the Manufacturing timeline to copy it.");
    clipboard = { session, setupId, copies };
    toast("info", "Operations copied. Use Ctrl+V or ⌘V to paste at the timeline marker.");
  }

  function paste() {
    if (!activeTrackId || clipboard?.session !== session || clipboard.setupId !== setupId) {
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
      const fresh = copies.map(({ operation, stage, trackId }) => {
        const stem = `${operation.name} copy`;
        let name = stem;
        for (let n = 2; names.has(name); n++) name = `${stem} ${n}`;
        names.add(name);
        return { stage, trackId: executionTrackId(setup, trackId), operation: { ...structuredClone(operation), id: uid(operation.kind), name } };
      });
      first = fresh[0]?.operation.id;
      return pastePlannedOperations(current, fresh, planBoundary(activeRow, end));
    }, "Paste manufacturing operations");
    if (!first) return toast("info", "The copied operations need their original workpiece context and tool position.");
    rememberPosition(activeTrackId, activeRow, end);
    setSelection({ setupId, ids: [first], anchor: first });
    select(`process:${first}`);
  }

  useEffect(() => {
    const copySelection = () => copy();
    const handleKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return false;
      if (event.key === "Escape" && selection?.setupId === setupId) {
        setSelection(undefined);
        return pickedIds.size > 0;
      }
      if (!pickedIds.size || (event.key !== "Delete" && event.key !== "Backspace")) return false;
      void remove([...pickedIds]);
      return true;
    };
    camTimelineActions.copy = copySelection;
    camTimelineActions.paste = paste;
    camTimelineActions.handleKey = handleKey;
    return () => {
      if (camTimelineActions.copy === copySelection) {
        camTimelineActions.copy = undefined;
        camTimelineActions.paste = undefined;
        camTimelineActions.handleKey = undefined;
      }
    };
  });

  async function putInFolder(id: string) {
    const trackId = steps.find(({ operation }) => operation.id === id)?.trackId;
    const operationIds = targets(id).filter((step) => step.trackId === trackId).map(({ operation }) => operation.id);
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

  async function remove(ids: string[]) {
    const names = ids.flatMap((id) => operations.get(id)?.name ?? []);
    if (!names.length) return;
    const single = names.length === 1;
    const confirmed = await confirmDialog({
      title: single ? "Delete operation" : "Delete selected operations",
      message: single ? `Delete “${names[0]}”?` : `Delete ${names.length} selected operations?`,
      confirmLabel: "Delete", danger: true,
    });
    if (!confirmed || useApp.getState().camToolpathSession !== session) return;
    save((current) => ids.reduce(deletePlannedOperation, current),
      single ? "Delete manufacturing operation" : "Delete manufacturing operations");
    setSelection((current) => current && { ...current, ids: current.ids.filter((id) => !ids.includes(id)) });
    if (selectedKey?.startsWith("process:") && ids.includes(selectedKey.slice("process:".length))) select(`setup:${setupId}`);
  }

  function move(id: string, target: string) {
    save((current) => movePlannedOperation(current, id, target), "Reorder manufacturing operations");
  }

  function moveAction(id: string, delta: number) {
    const trackId = steps.find(({ operation }) => operation.id === id)?.trackId;
    const row = steps.filter((step) => step.trackId === trackId);
    const index = row.findIndex(({ operation }) => operation.id === id);
    const target = row[index + delta]?.operation;
    if (!target) return { reason: "It's already at that end." };
    return { reason: planMoveProblem(project, id, target.id), run: () => move(id, target.id) };
  }

  function startTimelineDrag(event: DragEvent, source: DragSource, name: string) {
    event.dataTransfer.effectAllowed = "strategyId" in source ? "copy" : "move";
    event.dataTransfer.setData("text/plain", name);
    setDrag({ source });
  }

  function dropOn(event: DragEvent, key: string, target: TimelineDropTarget) {
    if (!drag) return;
    event.stopPropagation();
    event.preventDefault();
    const strip = event.currentTarget.closest<HTMLElement>(".cam-timeline__track");
    const trackId = strip?.dataset.trackId;
    if (!setupId || !trackId) return;
    target = { ...target, track: { setupId, id: trackId } };
    const { hover, source } = drag;
    const strategy = "strategyId" in source ? strategies.find(({ id }) => id === source.strategyId) : undefined;
    const effect = strategy ? "copy" : "move";
    const sameTarget = hover?.key === key && hover.target.operationId === target.operationId
      && hover.target.side === target.side && hover.target.folderId === target.folderId && hover.target.track?.id === trackId;
    if (event.type !== "drop" && sameTarget) {
      event.dataTransfer.dropEffect = hover.style === "cam-drop--blocked" ? "none" : effect;
      return;
    }
    const allowed = "strategyId" in source ? !!strategy?.enabled : moveTimelineItems(project, source, target) !== project;
    if (event.type === "drop") {
      if (strategy?.enabled) {
        const id = strategy.add(target);
        if (id) {
          closePalette();
          if (key === "insert") {
            rememberPosition(trackId, activeRow, end);
            revealInsertion.current = true;
          }
          setSelection({ setupId, ids: [id], anchor: id });
        }
      } else if (allowed && !("strategyId" in source)) {
        save((current) => moveTimelineItems(current, source, target), "Move manufacturing timeline items");
      }
      setDrag(undefined);
      return;
    }
    event.dataTransfer.dropEffect = allowed ? effect : "none";
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

  function renderStep({ entry, operation, planIndex, trackId }: (typeof steps)[number], index: number, showMarker = true) {
    const { id } = operation;
    const key = `process:${id}`;
    const name = `${operation.name} · ${machiningLabels[entry.stage]}`;
    const state = planIndex >= planEnd ? "rolledback" : operation.suppressed ? "suppressed" : "ok";
    const pathStatus = toolpathStatus(id);
    const selected = pickedIds.has(id);
    const folder = folderOf.get(id);
    return (
      <Fragment key={key}>
        {showMarker && trackId === activeTrackId && index === markerAt && marker}
        {(!folder || folder.open) && <div className="step-wrap" role="listitem">
          <button type="button" data-history-step ref={selectedKey === key ? selectedOperation : undefined} data-history-index={index} data-history-end={index + 1} className={`step step--${state} ${selected ? "is-selected" : ""} ${dropStyle(key)}`}
            aria-label={name} aria-pressed={selected} aria-description={`Toolpath ${pathStatus}`}
            onMouseEnter={() => setHoveredOperationId(id)}
            onMouseLeave={() => setHoveredOperationId(undefined)}
            onFocus={(event) => {
              if (event.currentTarget.matches(":focus-visible")) setFocusedOperationId(id);
            }}
            onBlur={() => setFocusedOperationId(undefined)}
            onClick={(event) => selectStep(id, trackId, event)}
            onDoubleClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey) selectStep(id, trackId); }}
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
                const action = moveAction(id, e.key === "ArrowLeft" ? -1 : 1);
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
            edit: { run: () => selectStep(id, trackId) },
            suppress: { run: () => updateOperation(id, (current) => ({ ...current, suppressed: !current.suppressed }),
              operation.suppressed ? "Unsuppress manufacturing operation" : "Suppress manufacturing operation") },
            rename: { run: () => void rename(id) },
            earlier: moveAction(id, -1),
            later: moveAction(id, 1),
            copy: { run: () => copy(id) },
            paste: { run: paste, reason: clipboard?.session === session && clipboard.setupId === setupId
              ? undefined : "Copy an operation from this setup first." },
            folder: { run: () => void putInFolder(id) },
            rollback: { run: () => {
              const row = steps.filter((step) => step.trackId === trackId);
              navigate(trackId, row, index);
            } },
            delete: { run: () => void remove(pickedIds.size ? [...pickedIds] : [id]) },
          }} />}
      </Fragment>
    );
  }

  function editTracks(update: (tracks: readonly CamExecutionTrack[], current: CamProject, currentSetup: NonNullable<typeof setup>) => readonly CamExecutionTrack[], label: string) {
    if (!setup) return;
    save((current) => {
      const currentSetup = current.setups.find(({ id }) => id === setup.id);
      if (!currentSetup) return current;
      const existing = executionTracks(currentSetup);
      const next = update(existing, current, currentSetup);
      return next === existing ? current : { ...current, setups: current.setups.map((item) =>
        item === currentSetup ? { ...item, executionTracks: next } : item) };
    }, label);
  }

  function addTrack() {
    editTracks((current) => {
      let number = current.length + 1;
      while (current.some(({ name }) => name === `Track ${number}`)) number++;
      return [...current, { id: uid("camtrack"), name: `Track ${number}` }];
    }, "Add execution track");
  }

  async function renameTrack(row: CamExecutionTrack) {
    const name = (await promptDialog({ title: "Rename execution track", label: "Name", initial: row.name,
      confirmLabel: "Rename" }))?.trim();
    if (!name || name === row.name || useApp.getState().camToolpathSession !== session) return;
    editTracks((current) => current.map((item) => item.id === row.id ? { ...item, name } : item), "Rename execution track");
  }

  function removeTrack(id: string) {
    editTracks((current, latest, currentSetup) => {
      const operationIds = new Set(latest.processes.filter((item) => item.setupId === currentSetup.id).map((item) => item.id));
      const occupied = getProcessPlan(latest).some((entry) => entry.kind === "process" && operationIds.has(entry.processId)
        && executionTrackId(currentSetup, entry.trackId) === id);
      return current.length <= 1 || occupied ? current : current.filter((item) => item.id !== id);
    }, "Remove execution track");
  }

  function insertionTarget(): TimelineDropTarget {
    const next = activeRow[end];
    const previous = activeRow[end - 1];
    const nextFolder = next && folderOf.get(next.operation.id);
    const folderId = previous && nextFolder === folderOf.get(previous.operation.id) ? nextFolder?.id : undefined;
    return { side: next ? "before" : "after", operationId: (next ?? previous)?.operation.id, folderId };
  }

  function addStrategy(strategy: Strategy) {
    if (!setupId || !activeTrackId) return;
    closePalette();
    const id = strategy.add({ ...insertionTarget(), track: { setupId, id: activeTrackId } });
    if (!id) return;
    rememberPosition(activeTrackId, activeRow, end);
    revealInsertion.current = true;
    setSelection({ setupId, ids: [id], anchor: id });
  }

  const marker = <>
    <Marker at={markerAt} max={activeRow.length} onDown={(event) => {
      track.current = event.currentTarget.closest<HTMLDivElement>(".cam-timeline__track");
      startDrag(event);
    }} onStep={setVisibleRollback} title="Drag to move the active track’s insertion marker and roll back the plan" />
    <button ref={insertionTile} className={`step cam-timeline__insert ${dropStyle("insert")}`} type="button" aria-label="Insert instruction"
      aria-haspopup="dialog" aria-expanded={!!paletteAnchor}
      onClick={(event) => setPaletteAnchor(paletteAnchor ? null : event.currentTarget)}
      onDragOver={(event) => dropOn(event, "insert", insertionTarget())}
      onDrop={(event) => dropOn(event, "insert", insertionTarget())}>
      <Icon name="plus" size={18} />
    </button>
  </>;

  return (
    <>
      <Popover anchor={paletteAnchor} open={!!paletteAnchor} onClose={closePalette}
        placement="top-start" className="cam-timeline__palette">
        <div role="dialog" aria-label="Manufacturing instruction palette">
          <div className="cam-timeline__palette-header">
            <strong>Insert instruction</strong>
            <button ref={paletteClose} type="button" className="iconbtn" aria-label="Close insertion palette" onClick={() => {
              closePalette();
              paletteAnchor?.focus();
            }}><Icon name="close" size={16} /></button>
          </div>
          <div className="cam-timeline__instructions">
            {contextInstructions.map((name) => (
              <button type="button" className="btn" key={name} disabled
                title="Available when execution context is implemented">{name}</button>
            ))}
            {strategies.map((strategy) => (
              <button type="button" className="btn" key={strategy.id} draggable={strategy.enabled} disabled={!strategy.enabled}
                aria-label={strategy.label} title={strategy.enabled ? `Insert at the marker or drag to a track · ${strategy.label}` : "Create a workpiece context first"}
                onDragStart={(event) => startTimelineDrag(event, { strategyId: strategy.id }, strategy.name)}
                onDragEnd={() => setDrag(undefined)} onClick={() => addStrategy(strategy)}>
                <MillIcon size={16} /> {strategy.name}
              </button>
            ))}
          </div>
        </div>
      </Popover>
      <div className="cam-timeline__controls">
        <div className="cam-timeline__setup-controls">
          {tracks.length > 0 && <Select className="cam-timeline__setup" size="sm" placement="top-start" allowReselect
            ariaLabel="Timeline setup" value={setupId} options={project.setups.map(({ id, name }) => ({ value: id, label: name }))}
            onChange={(id) => { setSelection(undefined); setDrag(undefined); select(`setup:${id}`); }} />}
          <HistoryControls end={end} count={activeRow.length} setRollback={setVisibleRollback} />
        </div>
        <div className="cam-timeline__operation-preview" aria-hidden="true">
          {previewStep && <>
            <span>{previewStep.operation.name} · {machiningLabels[previewStep.entry.stage]}{previewState} · Toolpath {toolpathStatus(previewStep.operation.id)}</span>
            <span className="cam-timeline__operation-shortcuts">Double-click or Enter to edit · F2 to rename · Drag or Alt + arrow keys to reorder</span>
          </>}
        </div>
        <div className="cam-timeline__setup-actions">
          {generationProgress && <span className="cam-timeline__generation-progress" role="status">{generationProgress}</span>}
          <button className="iconbtn" type="button" aria-label="Create setup" title="Create setup" onClick={createSetup}>
            <Icon name="folder" size={16} />
          </button>
          {setup && <>
            <button className="iconbtn" type="button" aria-label="Add track" title="Add track" onClick={addTrack}>
              <Icon name="plus" size={16} />
            </button>
            <span className="cam-timeline__action-divider" aria-hidden="true" />
          </>}
          <button className="iconbtn" type="button" disabled={generationDisabled}
            aria-label="Generate All Toolpaths" title="Generate All Toolpaths" onClick={generateAll}>
            <Icon name="refresh" size={16} />
          </button>
        </div>
      </div>
      <div className="cam-timeline__rows" ref={history} role="list" aria-label="Part history">
        {!setup && <span className="timeline__empty">Create a setup to start the part history.</span>}
        {tracks.map((rowTrack) => {
          const row = steps.filter((step) => step.trackId === rowTrack.id);
          const active = rowTrack.id === activeTrackId;
          const rowLast = row.at(-1);
          const endKey = `end:${rowTrack.id}`;
          return (
            <div className="cam-timeline__row" role="group" aria-label={rowTrack.name} key={rowTrack.id}>
              <div className="cam-timeline__track-label">
                <button className="btn cam-timeline__track-name" type="button" aria-pressed={active}
                  title={`Activate ${rowTrack.name}`} onClick={() => activateTrack(rowTrack.id)}>{rowTrack.name}</button>
                <button className="iconbtn" type="button" title={`Rename ${rowTrack.name}`}
                  aria-label={`Rename ${rowTrack.name}`} onClick={() => void renameTrack(rowTrack)}><Icon name="edit" size={14} /></button>
                <button className="iconbtn" type="button" disabled={!!rowLast || tracks.length === 1}
                  title={rowLast ? "Move operations out of this track to remove it" : `Remove ${rowTrack.name}`}
                  aria-label={`Remove ${rowTrack.name}`} onClick={() => removeTrack(rowTrack.id)}><Icon name="trash" size={14} /></button>
              </div>
              <div className={`timeline__track cam-timeline__track ${active ? "" : "cam-timeline__track--inactive"}`} data-track-id={rowTrack.id}
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
                onDragOverCapture={(event) => { if (drag) dragPointer.current = { x: event.clientX, strip: event.currentTarget }; }}
                onDragOver={() => { if (drag?.hover) setDrag({ source: drag.source }); }}
                onDragLeave={(event) => {
                  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                  dragPointer.current = null;
                  if (drag?.hover) setDrag({ source: drag.source });
                }}>
                {row.map((step, rowIndex) => {
                  const index = rowIndex;
                  const { operation } = step;
                  const folder = folderOf.get(operation.id);
                  if (!folder) return renderStep(step, index);
                  const previous = row[rowIndex - 1];
                  if (previous && folderOf.get(previous.operation.id) === folder) return null;

                  let folderEnd = rowIndex + 1;
                  while (true) {
                    const next = row[folderEnd];
                    if (!next || folderOf.get(next.operation.id) !== folder) break;
                    folderEnd++;
                  }
                  const children = row.slice(rowIndex, folderEnd);
                  const lastId = children.at(-1)?.operation.id ?? operation.id;
                  return (
                    <Fragment key={`process:${operation.id}`}>
                      {active && (index === markerAt || (!folder.open && index < markerAt && markerAt < folderEnd)) && marker}
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
                          <span>{folder.name}</span>
                          <Icon name={folder.open ? "chevronDown" : "chevronRight"} size={14} />
                        </button>
                        {children.map((child, offset) => renderStep(child, index + offset, offset > 0 && folder.open))}
                      </div>
                    </Fragment>
                  );
                })}
                {active && markerAt === row.length && marker}
                <div className={`cam-timeline__drop-end ${dropStyle(endKey)}`} data-drop-end
                  onDragOver={(e) => dropOn(e, endKey, { operationId: rowLast?.operation.id, side: "after" })}
                  onDrop={(e) => dropOn(e, endKey, { operationId: rowLast?.operation.id, side: "after" })}>
                  {!rowLast && <span className="timeline__empty">Drop an operation here</span>}
                </div>
              </div>
            </div>
          );
        })}
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
