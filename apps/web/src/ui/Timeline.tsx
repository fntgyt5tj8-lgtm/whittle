/**
 * The timeline: the design's history as a row of steps. Click to select,
 * double-click to edit, right-click for more. The marker shows how far the
 * model is built; drag it (or "Roll back to here") to insert steps earlier.
 */
import { useEffect, useState } from "react";
import type { Feature } from "@whittle/core";
import { activeEnd, datumKind, dependents, featureInputs, reorderProblem, sketchCountText } from "@whittle/core";
import { confirmDeleteFeature, editFeature, moveFeature, mutate, updateFeature, useApp, type Pick } from "../state/store";
import { featureIcon, Icon } from "./icons";
import { copySteps, folderSteps, renameStep, timelinePick } from "../state/steps";
import { promptDialog } from "../state/dialogs";
import { handlePick } from "../state/actions";
import { HistoryControls, HistoryMenu, Marker, menuLeft, useHistoryMarker, useMenuDismiss } from "./HistoryBar";

interface Menu {
  f: Feature;
  index: number;
  x: number;
  y: number;
}

/** The key values of a step, for its tooltip: "10 mm · Join", "R 2 mm · 4 edges". */
export function summary(f: Feature, units: string): string {
  const v = (e: string | undefined) => (e === undefined ? "" : /^\s*-?[\d.]+\s*$/.test(e) ? `${e.trim()} ${units}` : e);
  const op = "op" in f && typeof f.op === "string" ? { new: "New body", join: "Join", cut: "Cut", intersect: "Intersect" }[f.op as string] : undefined;
  const n = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
  const parts: (string | undefined)[] = (() => {
    switch (f.type) {
      case "sketch":
        return [sketchCountText(f)];
      case "extrude":
        return [f.extent === "through" ? "Through all" : f.extent === "face" ? "Up to a face" : v(f.distance) + (f.extent === "symmetric" ? " both ways" : ""), op];
      case "revolve":
        return [`${f.angle}°`, op];
      case "fillet":
        return [`R ${v(f.radius)}`, n(f.edges.length, "edge")];
      case "chamfer":
        return [v(f.distance), n(f.edges.length, "edge")];
      case "shell":
        return [`${v(f.thickness)} wall`, n(f.faces.length, "open face")];
      case "hole":
        return [`Ø ${v(f.diameter)}`, f.through ? "through" : v(f.depth) + " deep", n(f.points.length, "hole")];
      case "primitive":
        return [f.shape === "box" ? `${f.width} × ${f.depth} × ${f.height} ${units}` : `R ${v(f.radius)}`, op];
      default:
        return [op];
    }
  })();
  return parts.filter(Boolean).join(" · ");
}

export function Timeline({ content }: { content?: React.ReactNode }) {
  return content ? <div className="timeline" aria-label="Manufacturing timeline">{content}</div> : <CadTimeline />;
}

function CadTimeline() {
  const doc = useApp((s) => s.doc);
  const regen = useApp((s) => s.regen);
  const session = useApp((s) => s.session);
  const selection = useApp((s) => s.selection);
  const hover = useApp((s) => s.hover);
  // The step under the pointer: its parents and children are marked, and its geometry glows in the model.
  const [hot, setHot] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dragStep, setDragStep] = useState<{ from: number; over: number } | null>(null);
  // Steps picked for copying or folding (Shift/Ctrl+click adds); mirrored where the commands can see them.
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    timelinePick.ids = picked;
    return () => { timelinePick.ids = []; };
  }, [picked]);
  const [folderMenu, setFolderMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useMenuDismiss(!!folderMenu, () => setFolderMenu(null));
  const folders = (doc.folders ?? []).filter((x) => x.features.some((id) => doc.features.some((f) => f.id === id)));
  const folderOf = new Map(folders.flatMap((x) => x.features.map((id) => [id, x] as const)));
  const firstOf = new Set(folders.map((x) => doc.features.find((f) => x.features.includes(f.id))!.id));
  const setFolder = (id: string, label: string, recipe: (x: { name: string; open: boolean; features: string[] }) => void) =>
    mutate(label, (d) => {
      const x = d.folders?.find((y) => y.id === id);
      if (x) recipe(x);
    });
  const end = activeEnd(doc);

  const setRollback = (i: number | null) =>
    mutate("Move timeline marker", (d) => {
      d.rollback = i === null || i >= d.features.length ? null : i;
    });

  const { track, markerAt, startDrag } = useHistoryMarker(end, setRollback);

  function moveAction(from: number, to: number) {
    const reason = to < 0 || to >= doc.features.length ? "It's already at that end." : reorderProblem(doc, from, to);
    return { reason: reason ?? undefined, run: () => moveFeature(from, to) };
  }

  const isSelected = (f: Feature) =>
    session?.featureId === f.id || selection.some((p) => (p.kind === "datum" && p.id === f.id) || (p.kind === "sketch" && p.sketchId === f.id) || ((p.kind === "body" || p.kind === "face" || p.kind === "edge") && p.bodyId === f.id));

  const hotFeature = doc.features.find((x) => x.id === hot);
  const parents = new Set(hotFeature ? featureInputs(hotFeature) : []);
  const children = new Set(hotFeature ? dependents(doc, hotFeature.id).map((x) => x.id) : []);
  // Hovering geometry in the model lights the step that made it.
  const hovered = hover && (hover.kind === "sketch" ? hover.sketchId : hover.kind === "datum" ? hover.id : "bodyId" in hover ? hover.bodyId : null);
  const geometryPick = (f: Feature): Pick | null => {
    const kind = datumKind(f);
    if (kind) return { kind: "datum", id: f.id, datumKind: kind };
    if (f.type === "sketch") return { kind: "sketch", sketchId: f.id };
    return doc.bodies[f.id] ? { kind: "body", bodyId: f.id } : null;
  };
  const glow = (f: Feature, pick: Pick | null) => {
    const body = featureInputs(f).find((i) => doc.bodies[i]);
    useApp.setState({ hover: pick ?? (body ? { kind: "body", bodyId: body } : null) });
  };

  return (
    <div className="timeline" aria-label="Timeline">
      <HistoryControls end={end} count={doc.features.length} setRollback={setRollback} />

      <div className="timeline__track" ref={track}>
        {doc.features.length === 0 && <span className="timeline__empty">Your design history appears here, one step per feature.</span>}
        {doc.features.map((f, i) => {
          const pick = geometryPick(f);
          const selected = isSelected(f) || (picked.length > 1 && picked.includes(f.id));
          const st = regen?.status.find((s) => s.id === f.id);
          const state = i >= end ? "rolledback" : f.suppressed ? "suppressed" : st?.state ?? "ok";
          return (
            <div key={f.id} className={`step-wrap ${folderOf.get(f.id) && !folderOf.get(f.id)!.open ? "is-folded" : ""}`}>
              {firstOf.has(f.id) && (() => {
                const fo = folderOf.get(f.id)!;
                return (
                  <button
                    className={`folder ${fo.open ? "is-open" : ""}`}
                    title={`${fo.name}: ${fo.features.filter((id) => doc.features.some((x) => x.id === id)).length} step${fo.features.filter((id) => doc.features.some((x) => x.id === id)).length > 1 ? "s" : ""} · click to ${fo.open ? "fold" : "open"} · right-click to rename or ungroup`}
                    onClick={() => setFolder(fo.id, fo.open ? "Fold folder" : "Open folder", (x) => void (x.open = !x.open))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setFolderMenu({ id: fo.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <Icon name="folder" size={16} />
                    <span>{fo.name}</span>
                  </button>
                );
              })()}
              {i === markerAt && <Marker onDown={(e) => startDrag(e)} at={markerAt} max={doc.features.length} onStep={(to) => setRollback(to >= doc.features.length ? null : to)} />}
              <button
                data-history-step
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", f.name);
                  setDragStep({ from: i, over: i });
                }}
                onDragOver={(e) => {
                  if (!dragStep) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = reorderProblem(doc, dragStep.from, i) ? "none" : "move";
                  if (dragStep.over !== i) setDragStep({ ...dragStep, over: i });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragStep) moveFeature(dragStep.from, i);
                  setDragStep(null);
                }}
                onDragEnd={() => setDragStep(null)}
                className={`step step--${state} ${selected ? "is-selected" : ""} ${folderOf.has(f.id) ? "is-in-folder" : ""} ${dragStep && dragStep.over === i && dragStep.from !== i ? (reorderProblem(doc, dragStep.from, i) ? "is-drop-blocked" : "is-drop-before") : ""} ${parents.has(f.id) ? "is-parent" : ""} ${children.has(f.id) ? "is-child" : ""} ${hovered === f.id ? "is-hovered" : ""}`}
                onPointerEnter={() => (setHot(f.id), glow(f, pick))}
                onPointerLeave={() => (setHot(null), useApp.setState({ hover: null }))}
                aria-pressed={selected}
                aria-label={`${f.name}${summary(f, doc.units) ? ", " + summary(f, doc.units) : ""}${state === "error" ? ", failed" : state === "warning" ? ", needs a look" : ""}`}
                title={`${f.name}${summary(f, doc.units) ? " · " + summary(f, doc.units) : ""}${st?.message ? "\n" + st.message : ""}\nDouble-click (or Enter) to edit · F2 to rename · drag, or Alt + arrow keys, to reorder`}
                onClick={(e) => {
                  if (e.shiftKey || e.ctrlKey || e.metaKey) return setPicked((p) => (p.includes(f.id) ? p.filter((x) => x !== f.id) : [...p, f.id]));
                  setPicked([f.id]);
                  const { mode } = useApp.getState();
                  if (pick?.kind === "datum" && i < end && (mode.kind === "model" || mode.kind === "pickPlane")) {
                    handlePick(pick, false);
                  } else {
                    useApp.setState({ selection: pick ? [pick] : [] });
                  }
                }}
                onDoubleClick={() => editFeature(f.id)}
                onKeyDown={(e) => {
                  // Reordering without a mouse: Alt + arrow moves the step earlier or later, Enter edits it.
                  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                    e.preventDefault();
                    const to = i + (e.key === "ArrowLeft" ? -1 : 1);
                    if (to >= 0 && to < doc.features.length) moveFeature(i, to);
                  } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    editFeature(f.id);
                  } else if (e.key === "F2") {
                    e.preventDefault();
                    void renameStep(f.id);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ f, index: i, x: e.clientX, y: e.clientY });
                }}
              >
                <Icon name={featureIcon(f)} size={18} />
                {(state === "error" || state === "warning") && <span className={`step__badge step__badge--${state}`} />}
              </button>
            </div>
          );
        })}
        {markerAt >= doc.features.length && doc.features.length > 0 && <Marker onDown={(e) => startDrag(e)} at={markerAt} max={doc.features.length} onStep={(to) => setRollback(to >= doc.features.length ? null : to)} />}
      </div>

      {folderMenu && (
        <div className="menu" style={{ left: menuLeft(folderMenu.x), top: folderMenu.y - 8 }} role="menu" onPointerDown={(e) => e.stopPropagation()}>
          <button
            role="menuitem"
            onClick={async () => {
              const fo = folders.find((x) => x.id === folderMenu.id);
              setFolderMenu(null);
              const name = fo && (await promptDialog({ title: "Rename folder", label: "Name", initial: fo.name, confirmLabel: "Rename" }));
              if (fo && name?.trim()) setFolder(fo.id, "Rename folder", (x) => void (x.name = name.trim()));
            }}
          >
            <Icon name="edit" size={16} /> Rename
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const id = folderMenu.id;
              setFolderMenu(null);
              mutate("Ungroup folder", (d) => void (d.folders = d.folders?.filter((x) => x.id !== id)));
            }}
          >
            <Icon name="unlink" size={16} /> Ungroup
          </button>
        </div>
      )}

      {menu && <HistoryMenu x={menu.x} y={menu.y} name={menu.f.name} suppressed={menu.f.suppressed}
        close={() => setMenu(null)} pickedCount={picked.includes(menu.f.id) ? picked.length : 0}
        actions={{
          edit: { run: () => editFeature(menu.f.id) },
          suppress: { run: () => updateFeature(menu.f.id, menu.f.suppressed ? "Unsuppress" : "Suppress", (d) => void (d.suppressed = !d.suppressed)) },
          rename: { run: () => void renameStep(menu.f.id) },
          earlier: moveAction(menu.index, menu.index - 1),
          later: moveAction(menu.index, menu.index + 1),
          copy: { run: () => {
            if (!picked.includes(menu.f.id)) timelinePick.ids = [menu.f.id];
            copySteps();
          } },
          folder: { run: () => {
            if (!picked.includes(menu.f.id)) timelinePick.ids = [menu.f.id];
            void folderSteps().then(() => setPicked([]));
          } },
          rollback: { run: () => setRollback(menu.index) },
          delete: { run: () => void confirmDeleteFeature(menu.f.id) },
        }} />}
    </div>
  );
}
