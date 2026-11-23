import { useEffect, useState } from "react";
import {
  CAM_WORLD, exportAptProgram, type AptOperation, type CamWorkpieceContext, addProcess, addSetup, getProcessPlan, validateOperationTooling, validateProject,
  type CamCuttingConditions, type CamGeometryRef, type CamMachiningStage, type CamPlanItem, type CamProcess, type CamProject, type CamSetup, type CircularProfileSettings, type ContourMillingSettings, type FacingMillingSettings, type PocketMillingSettings,
} from "@whittle/cam";
import type { CamCadAdapter } from "../cadAdapter";
import { demoMachine, demoTracks, trackKey } from "../machine";
import { uid } from "@whittle/core";
import { SetupEditor } from "./SetupEditor";
import { ContourMilling } from "./ContourMilling";
import { OperationOrientation } from "./OperationOrientation";
import { resolveOrientation } from "../orientation";
import { generateMilling } from "../milling";
import { buildCircularProfile } from "../circularProfile";
import { downloadApt } from "../downloadApt";
import { ProfileExport } from "./ProfileExport";
import { MillIcon } from "./icons/MillIcon";
import { PlanIcon } from "./icons/PlanIcon";
import "./cam.css";

export const manufacturingLabel = "Manufacturing";

const machiningLabels = { main: "Main machining", sub: "Sub / back-working" };
const stageLabels = { transfer: "Transfer", ejection: "Ejection" };

function itemKey(item: CamPlanItem) {
  return item.kind === "process" ? `process:${item.processId}` : `stage:${item.id}`;
}

export function useCamWorkspace(
  cad: CamCadAdapter,
  documentId: string | undefined,
  project: CamProject,
  setProject: (update: (current: CamProject) => CamProject, label: string, mergeKey?: string) => void,
  openProperties: () => void,
  sourceErrors: readonly string[],
  canPickGeometry: boolean,
  clearPickSelection: () => void,
) {
  const [geometryPick, setGeometryPick] = useState<{ documentId?: string; key?: string; kind: "sketch" | "island" | "face" | "facing-face" }>();
  const [selection, setSelection] = useState<{ documentId?: string; key?: string }>({});
  const [contextSelection, setContextSelection] = useState<{ documentId?: string; setupId?: string; id?: string }>({});
  const selectedKey = selection.documentId === documentId ? selection.key : undefined;
  const setSelectedKey = (key?: string) => {
    setGeometryPick(undefined);
    setSelection({ documentId, key });
  };

  const plan = getProcessPlan(project);
  const selectedItem = plan.find((item) => itemKey(item) === selectedKey);
  const process = selectedItem?.kind === "process"
    ? project.processes.find((item) => item.id === selectedItem.processId)
    : undefined;
  const setupId = selectedItem?.kind === "process" ? process?.setupId : selectedItem?.setupId;
  const setupKey = selectedKey?.startsWith("setup:") ? selectedKey.slice("setup:".length) : undefined;
  const setup = project.setups.find((item) => item.id === (setupId ?? setupKey))
    ?? (selectedItem ? undefined : project.setups[0]);
  const contexts = setup?.contexts ?? [];
  const context = process ? contexts.find((item) => item.id === process.contextId)
    : (contextSelection.documentId === documentId && contextSelection.setupId === setup?.id ? contexts.find((item) => item.id === contextSelection.id) : undefined)
      ?? contexts[0];
  const selectContext = (id?: string) => setContextSelection({ documentId, setupId: setup?.id, id });
  const usedContexts = new Set(project.processes.filter((item) => item.setupId === setup?.id).map((item) => item.contextId));
  const setupInUse = !!usedContexts.size || plan.some((item) => item.kind !== "process" && item.setupId === setup?.id);
  function frameFor(workpiece?: CamWorkpieceContext) {
    const frame = workpiece?.frame;
    if (frame?.kind === "native") return cad.resolveCoordinateSystem(frame.csysId);
    if (frame?.kind === "legacy-world") return CAM_WORLD;
    if (frame?.kind === "legacy-sketch" && frame.sketch) return cad.resolveSketchFrame(frame.sketch);
  }

  const resolveFrame = () => frameFor(context);

  function editSetup(update: (current: CamSetup) => CamSetup, label: string, mergeKey?: string) {
    setProject((current) => ({
      ...current, setups: current.setups.map((item) => item.id === setup?.id ? update(item) : item),
    }), label, mergeKey);
  }

  function deleteSetup() {
    if (setupInUse) return;
    setProject((current) => ({ ...current, setups: current.setups.filter((item) => item.id !== setup?.id) }),
      "Delete manufacturing setup");
    setSelectedKey();
  }

  const selectedSketch = cad.getSelection().find((ref) => ref.kind === "sketch");
  const contourName = process?.contour && cad.resolveGeometry(process.contour)?.name;
  const pickingGeometry = !!process && canPickGeometry && !!geometryPick
    && geometryPick.documentId === documentId && geometryPick.key === selectedKey;
  const pickingFace = pickingGeometry && geometryPick.kind === "face";
  const pickingFacingFace = pickingGeometry && geometryPick.kind === "facing-face";
  const pickingSketch = pickingGeometry && (geometryPick.kind === "sketch" || geometryPick.kind === "island");
  const selectedFace = pickingFace || pickingFacingFace ? cad.selectedFloor?.() : undefined;
  const selectedSketchValid = !!selectedSketch && ((process?.contourMilling || process?.pocketMilling || process?.facingMilling) ? !!cad.resolveGeometry(selectedSketch) : !!cad.resolveCircularProfile?.(selectedSketch));

  function changeContour(contour: CamGeometryRef | undefined) {
    if (!process) return;
    setProject((current) => ({
      ...current,
      processes: current.processes.map((item) => item.id === process.id ? { ...item, contour, ...(contour ? { boundaryEdges: undefined, facingFace: undefined } : {}) } : item),
    }), contour ? "Assign operation profile sketch" : "Remove operation profile sketch");
    setGeometryPick(undefined);
  }

  const pickingIsland = pickingSketch && geometryPick?.kind === "island";
  const sameSketch = (a: CamGeometryRef | undefined, b: CamGeometryRef) =>
    a?.documentId === b.documentId && a.entityId === b.entityId;
  const duplicateIsland = pickingIsland && !!selectedSketch && (sameSketch(process?.contour, selectedSketch)
    || process?.islandSketches?.some((island) => sameSketch(island, selectedSketch)));

  function changeIslands(islandSketches: readonly CamGeometryRef[]) {
    if (!process) return;
    setProject((current) => ({
      ...current,
      processes: current.processes.map((item) => item.id === process.id ? { ...item, islandSketches } : item),
    }), "Edit island sketches");
    setGeometryPick(undefined);
  }

  useEffect(() => {
    if (process && selectedFace && pickingFacingFace) {
      changeModelGeometry({ facingFace: selectedFace, boundaryEdges: undefined, contour: undefined });
      setGeometryPick(undefined);
      openProperties();
    } else if (process && documentId && selectedFace && pickingFace) {
      changeOrientation({ kind: "face", documentId, face: selectedFace, flip: process.orientation?.flip });
      openProperties();
    } else if (pickingSketch && selectedSketchValid && selectedSketch && !duplicateIsland) {
      if (pickingIsland) changeIslands([...(process?.islandSketches ?? []), selectedSketch]);
      else changeContour(selectedSketch);
      openProperties();
    } else if (!canPickGeometry && geometryPick) {
      setGeometryPick(undefined);
    }
  });

  useEffect(() => {
    if (!pickingGeometry) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setGeometryPick(undefined);
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [pickingGeometry]);

  const tools = project.toolPositions ?? [];
  const operationTool = tools.find((tool) => tool.id === process?.toolPositionId);
  const cutting = operationTool && cad.resolveToolCutting?.(operationTool.id);
  const toolDiameter = cutting?.ok && cutting.value.family === "FLAT" ? cutting.value.diameter : undefined;
  const assignedTrack = process?.track;
  const track = assignedTrack && demoTracks.find((item) => trackKey(item) === trackKey(assignedTrack));
  const unit = track && demoMachine.executionUnits.find((item) => item.id === track.unitId);

  function createSetup() {
    const id = uid("setup");
    let number = project.setups.length + 1;
    while (project.setups.some((setup) => setup.name === `Setup ${number}`)) number += 1;
    setProject((current) => addSetup(current, { id, name: `Setup ${number}`, contexts: [] }),
      "Create manufacturing setup");
    setSelectedKey(`setup:${id}`);
  }

  function createProfile(mode: "profile" | "contour" | "pocket" | "adaptive" | "facing" = "profile") {
    if (!setup || !context) return;
    const number = project.processes.length + 1;
    const kind = mode === "contour" ? "profile" : mode;
    const id = uid(kind);
    const contourMilling: ContourMillingSettings | undefined = mode === "contour"
      ? { side: "center", direction: "forward", depth: "", clearance: "2" } : undefined;
    const pocketMilling: PocketMillingSettings | undefined = kind === "pocket" || kind === "adaptive"
      ? { depth: "", clearance: "2", stepover: kind === "adaptive" ? "15" : "50" } : undefined;
    const facingMilling: FacingMillingSettings | undefined = kind === "facing"
      ? { top: "0", depth: "", clearance: "2", stepover: "50", strategy: "zigzag" } : undefined;
    const contour = selectedSketch
      ?? (setup.part?.kind === "sketch" ? setup.part : undefined);
    const name = { profile: "Profile", contour: "Contour", pocket: "Pocket", adaptive: "Adaptive", facing: "Facing" }[mode];
    const action = { profile: "Add circular profile", contour: "Add contour milling", pocket: "Add pocket milling", adaptive: "Add adaptive clearing", facing: "Add facing milling" }[mode];
    setProject((current) => addProcess(current, {
      id, name: `${name} ${number}`, setupId: setup.id, contextId: context.id, kind, contour, contourMilling, pocketMilling, facingMilling, orientation: mode === "profile" ? undefined : { kind: "setup" },
    }), action);
    setSelectedKey(`process:${id}`);
  }

  function removeContext(id: string) {
    if (!setup) return false;
    let removed = false;
    setProject((current) => {
      if (current.processes.some((item) => item.setupId === setup.id && item.contextId === id)) return current;
      removed = true;
      return {
        ...current, setups: current.setups.map((item) => item.id === setup.id
          ? { ...item, contexts: item.contexts?.filter((context) => context.id !== id) } : item),
      };
    }, "Remove workpiece context");
    if (removed && contextSelection.id === id) selectContext();
    return removed;
  }

  function changeMachiningStage(stage: CamMachiningStage) {
    setProject((current) => ({
      ...current,
      processPlan: getProcessPlan(current).map((item) =>
        item.kind === "process" && itemKey(item) === selectedKey ? { ...item, stage } : item),
    }), "Change machining stage");
  }

  function changeTrack(key: string) {
    const assignment = demoTracks.find((item) => trackKey(item) === key);
    setProject((current) => ({
      ...current,
      processes: current.processes.map((item) => item.id === process?.id ? {
        ...item,
        track: assignment && { unitId: assignment.unitId, id: assignment.id },
      } : item),
    }), "Assign execution track");
  }

  function changeOrientation(orientation: CamProcess["orientation"]) {
    setGeometryPick(undefined);
    setProject((current) => ({
      ...current, processes: current.processes.map((item) => item.id === process?.id ? { ...item, orientation } : item),
    }), "Change machining orientation");
  }

  function changeProfile(settings: Partial<CircularProfileSettings>) {
    if (!process) return;
    setProject((current) => ({
      ...current,
      processes: current.processes.map((item) => item.id === process.id
        ? { ...item, profile: { ...item.profile, ...settings } }
        : item),
    }), "Edit cutting conditions", `cam:${process.id}:${Object.keys(settings)[0]}`);
  }

  function changeCuttingConditions(changes: Partial<CamCuttingConditions>) {
    if (!process) return;
    setProject((current) => ({
      ...current,
      processes: current.processes.map((item) => item.id === process.id
        ? { ...item, cuttingConditions: { ...item.cuttingConditions, ...changes } }
        : item),
    }), "Edit cutting conditions", `cam:${process.id}:${Object.keys(changes)[0]}`);
  }

  function changeModelGeometry(changes: Pick<Partial<CamProcess>, "boundaryEdges" | "islandEdges" | "floorFace" | "facingFace" | "contour">) {
    if (!process) return;
    setProject((current) => ({
      ...current,
      processes: current.processes.map((item) => item.id === process.id ? { ...item, ...changes } : item),
    }), "Edit operation model geometry");
  }

  function changeMilling(changes: Partial<ContourMillingSettings & PocketMillingSettings & FacingMillingSettings>) {
    if (!process) return;
    const updated = process.facingMilling
      ? { facingMilling: { ...process.facingMilling, ...changes } }
      : process.pocketMilling
      ? { pocketMilling: { ...process.pocketMilling, ...changes } }
      : process.contourMilling && { contourMilling: { ...process.contourMilling, ...changes } };
    if (!updated) return;
    setProject((current) => ({
      ...current,
      processes: current.processes.map((item) => item.id === process.id ? { ...item, ...updated } : item),
    }), process.kind === "facing" ? "Edit facing milling" : process.kind === "adaptive" ? "Edit adaptive clearing" : process.pocketMilling ? "Edit pocket milling" : "Edit contour milling", `cam:${process.id}:${Object.keys(changes)[0]}`);
  }

  function selectTile(key?: string) {
    setSelectedKey(key);
    openProperties();
  }

  const commands = [
    { id: "setup", label: "Create setup", icon: MillIcon, enabled: true, run: createSetup },
    { id: "profile", label: "Add profile", icon: MillIcon, enabled: !!setup && !!context, run: () => createProfile() },
    { id: "contour", label: "Add contour milling", icon: MillIcon, enabled: !!setup && !!context, run: () => createProfile("contour") },
    { id: "pocket", label: "Add pocket milling", icon: MillIcon, enabled: !!setup && !!context, run: () => createProfile("pocket") },
    { id: "adaptive", label: "Add adaptive clearing", icon: MillIcon, enabled: !!setup && !!context, run: () => createProfile("adaptive") },
    { id: "facing", label: "Add facing milling", icon: MillIcon, enabled: !!setup && !!context, run: () => createProfile("facing") },
  ];
  const millingSettings = process?.facingMilling ?? process?.pocketMilling ?? process?.contourMilling;
  const selectedStage = selectedItem && selectedItem.kind !== "process" ? selectedItem : undefined;
  const errors = [...validateProject(project), ...sourceErrors];
  const datums = cad.getCoordinateSystems();
  for (const item of project.processes) {
    if (item.contour && !cad.resolveGeometry(item.contour)) errors.push(`${item.name} references a missing profile sketch.`);
  }
  const contextErrors = (workpiece = context) => (workpiece?.bodies ?? []).flatMap(({ body, role }) =>
    cad.resolveGeometry(body) ? [] : [`The ${role} body (${body.entityId}) is unavailable.`]);
  const referenceErrors = () => [...(process ? validateOperationTooling(process, tools) : []), ...contextErrors()];
  const operationErrors = () => [
    ...referenceErrors(),
    ...(operationTool && !cad.resolveCoordinateSystem(operationTool.tipCsysId) ? ["Resolve the selected tool's TIP before exporting."] : []),
    ...(operationTool && toolDiameter === undefined
      ? cutting?.ok ? ["Circular profile export requires a FLAT cutter."]
        : cutting?.errors ?? ["The selected cutting component is unavailable."]
      : []),
  ];
  for (const item of project.setups.flatMap((item) => item.contexts ?? [])) {
    if (item.frame.kind === "native" && item.frame.csysId) {
      const csysId = item.frame.csysId;
      if (!datums.some((datum) => datum.id === csysId)) errors.push(`${item.name} references a missing coordinate system.`);
    }
    if (item.frame.kind === "legacy-sketch" && (!item.frame.sketch || !cad.resolveGeometry(item.frame.sketch))) {
      errors.push(`${item.name} references a missing sketch coordinate system.`);
    }
    for (const { body, role } of item.bodies) {
      if (!cad.resolveGeometry(body)) errors.push(`${item.name} references an unavailable ${role} body (${body.entityId}).`);
    }
  }

  const [aptError, setAptError] = useState<{ project: CamProject; selection: typeof selectedKey; errors: readonly string[] }>();
  function exportOperations(items: readonly CamProcess[], filename: string) {
    const fail = (errors: readonly string[]) => setAptError({ project, selection: selectedKey, errors });
    const operations: AptOperation[] = [];
    for (const item of items) {
      const workpiece = contexts.find(({ id }) => id === item.contextId);
      const frame = frameFor(workpiece);
      if (!frame) return fail([`${item.name}: Resolve the workpiece coordinate system.`]);
      const tool = tools.find(({ id }) => id === item.toolPositionId);
      const references = [...validateOperationTooling(item, tools), ...contextErrors(workpiece)];
      const settings = item.facingMilling ?? item.pocketMilling ?? item.contourMilling;
      const profile = item.profile;
      const conditions = settings ? item.cuttingConditions : profile;
      const metadata = {
        name: item.name, frame, toolNumber: tool?.number,
        spindleRpm: conditions?.spindleRpm?.trim() ? Number(conditions.spindleRpm) : undefined,
      };
      if (settings) {
        const generated = generateMilling(cad, documentId, item, settings, tool, frame, references);
        if (!generated.ok) return fail(generated.errors.map((error) => `${item.name}: ${error}`));
        const { path, diameter } = generated.value;
        operations.push({ ...metadata, frame: path.frame, path: {
          tool: { kind: "flat-endmill", diameter }, motions: path.motions,
          feed: Number(conditions?.feed), plungeFeed: Number(conditions?.plungeFeed),
        } });
      } else {
        const cutting = tool && cad.resolveToolCutting?.(tool.id);
        if (tool && (!cutting?.ok || cutting.value.family !== "FLAT" || !cad.resolveCoordinateSystem(tool.tipCsysId))) {
          return fail([`${item.name}: Resolve the assigned tool's FLAT cutter and TIP.`]);
        }
        const path = buildCircularProfile(item.contour && cad.resolveCircularProfile?.(item.contour), frame,
          cutting?.ok ? cutting.value.diameter : undefined, profile,
          (setup, sketch) => item.orientation ? resolveOrientation(cad, documentId, setup, item.orientation, sketch) : undefined,
          () => references);
        if (!path.ok) return fail(path.errors.map((error) => `${item.name}: ${error}`));
        operations.push({ ...metadata, path: path.value });
      }
    }
    const apt = exportAptProgram(filename, operations);
    if (!apt.ok) return fail(apt.errors);
    setAptError(undefined);
    downloadApt(filename, apt.value);
  }
  const setupOperations = setup ? plan.flatMap((item) => {
    if (item.kind !== "process") return [];
    const operation = project.processes.find(({ id }) => id === item.processId);
    return operation?.setupId === setup.id ? [operation] : [];
  }) : [];

  const properties = (
    <div className="cam-properties">
      <h2>{process?.name ?? (selectedStage && stageLabels[selectedStage.kind]) ?? (setup ? "PART1" : manufacturingLabel)}</h2>
      <p>{demoMachine.name} · {demoMachine.controller}</p>
      <dl>
        {selectedItem && <><dt>Setup</dt><dd>{setup?.name}</dd></>}
        {process && selectedItem?.kind === "process" && <>
          <dt><label htmlFor="cam-process-context">Workpiece context</label></dt>
          <dd><select id="cam-process-context" value={context?.id ?? ""} onChange={(event) => {
            const contextId = event.target.value;
            setProject((current) => ({
              ...current, processes: current.processes.map((item) => item.id === process.id ? { ...item, contextId } : item),
            }), "Change operation workpiece context");
          }}>
            {!context && <option value="" disabled>Workpiece context unavailable</option>}
            {contexts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></dd>
          <OperationOrientation cad={cad} documentId={documentId} orientation={process.orientation} sketchDefault={!millingSettings}
            pickingFace={pickingFace} canPickFace={canPickGeometry} onChange={changeOrientation}
            onPickFace={() => {
              clearPickSelection();
              setGeometryPick({ documentId, key: selectedKey, kind: "face" });
            }} onCancelFace={() => setGeometryPick(undefined)} />
          <dt><label htmlFor="cam-operation-tool">Tool position</label></dt>
          <dd><select id="cam-operation-tool" value={process.toolPositionId ?? ""} onChange={(event) => {
            const toolPositionId = event.target.value || undefined;
            setProject((current) => ({
              ...current, processes: current.processes.map((item) => item.id === process.id ? { ...item, toolPositionId } : item),
            }), "Assign operation tool position");
          }}>
            <option value="">Unassigned</option>
            {process.toolPositionId && !operationTool && <option value={process.toolPositionId}>Tool position unavailable</option>}
            {[...tools].sort((a, b) => a.number - b.number).map((tool) =>
              <option key={tool.id} value={tool.id}>T{String(tool.number).padStart(2, "0")} — {tool.name}</option>)}
          </select></dd>
          <dt><label htmlFor="cam-machining-stage">Machining stage</label></dt>
          <dd><select id="cam-machining-stage" value={selectedItem.stage}
            onChange={(event) => changeMachiningStage(event.target.value as CamMachiningStage)}>
            <option value="main">{machiningLabels.main}</option>
            <option value="sub">{machiningLabels.sub}</option>
          </select></dd>
          <dt><label htmlFor="cam-execution-track">Execution track</label></dt>
          <dd><select id="cam-execution-track" value={assignedTrack ? trackKey(assignedTrack) : ""}
            onChange={(event) => changeTrack(event.target.value)}>
            <option value="">Unassigned</option>
            {assignedTrack && !track && <option value={trackKey(assignedTrack)}>Track unavailable</option>}
            {demoMachine.executionUnits.map((executionUnit) => (
              <optgroup key={executionUnit.id} label={executionUnit.name}>
                {executionUnit.tracks.map((item) => (
                  <option key={item.id} value={trackKey({ unitId: executionUnit.id, id: item.id })}>
                    {item.name} · Channel {item.channel}
                  </option>
                ))}
              </optgroup>
            ))}
          </select></dd>
          {unit && <><dt>Execution unit</dt><dd>{unit.name}</dd></>}
        </>}
      </dl>
      {process && <>
        <dl>
          <dt>{process.kind === "facing" ? "Facing boundary" : process.boundaryEdges?.length ? "Boundary geometry" : process.pocketMilling ? "Pocket boundary sketch" : process.contourMilling ? "Contour sketch" : "Profile sketch"}</dt>
          <dd>{process.facingFace ? (cad.resolveFloor?.(process.facingFace) ? "Selected planar face" : "Face unavailable") : process.boundaryEdges?.length ? "Selected model edges" : contourName ?? (process.contour ? "Unavailable" : "Unassigned")}</dd>
        </dl>
        <div className="cam-properties__actions">
          <button type="button" aria-pressed={pickingSketch && !pickingIsland} onClick={() => {
            if (pickingSketch && !pickingIsland) setGeometryPick(undefined);
            else {
              clearPickSelection();
              setGeometryPick({ documentId, key: selectedKey, kind: "sketch" });
            }
          }}>{pickingSketch && !pickingIsland ? "Cancel Sketch Pick" : process.contour ? "Replace Sketch" : "Pick Sketch"}</button>
          {process.kind === "facing" && canPickGeometry && <button type="button" aria-pressed={pickingFacingFace} onClick={() => {
            if (pickingFacingFace) setGeometryPick(undefined);
            else {
              clearPickSelection();
              setGeometryPick({ documentId, key: selectedKey, kind: "facing-face" });
            }
          }}>{pickingFacingFace ? "Cancel Facing Face Pick" : "Pick Facing Face"}</button>}
          {process.facingFace && <button type="button" onClick={() => changeModelGeometry({ facingFace: undefined })}>Remove Facing Face</button>}
          {process.contour && <button type="button" onClick={() => changeContour(undefined)}>Remove Sketch</button>}
        </div>
        {process.pocketMilling && (process.contour || process.boundaryEdges?.length) ? <>
          <ul aria-label="Island sketches">
            {(process.islandSketches ?? []).map((ref, index) => {
              const name = cad.resolveGeometry(ref)?.name ?? "Unavailable sketch";
              return <li key={JSON.stringify([ref.documentId, ref.entityId])}>{name}{" "}
                <button type="button" aria-label={`Remove island ${name}`}
                  onClick={() => changeIslands((process.islandSketches ?? []).filter((_, i) => i !== index))}>Remove</button>
              </li>;
            })}
          </ul>
          <button type="button" aria-pressed={pickingIsland} onClick={() => {
            if (pickingIsland) setGeometryPick(undefined);
            else {
              clearPickSelection();
              setGeometryPick({ documentId, key: selectedKey, kind: "island" });
            }
          }}>{pickingIsland ? "Cancel Island Pick" : "Add Island Sketch"}</button>
        </> : null}
        {pickingFacingFace && <p role="status">Click a planar workpiece face in the 3D view.</p>}
        {pickingSketch && <p role="status">{duplicateIsland ? "Choose a different sketch for the island." : selectedSketch && !selectedSketchValid
          ? (millingSettings ? "Choose a native sketch." : "Choose a built sketch with one circle.")
          : "Click a sketch in the 3D view or Browser."}</p>}
      </>}
      {process && millingSettings && canPickGeometry && !pickingGeometry && <ContourMilling
        key={`${documentId}/${process.id}`} cad={cad} process={process} settings={millingSettings}
        tool={operationTool} resolveFrame={resolveFrame} validateReferences={referenceErrors} onChange={changeMilling} onGeometryChange={changeModelGeometry} />}
      {process && millingSettings && canPickGeometry && !pickingGeometry && <>
        <dl>{([
          ["feed", "Cut feed (mm/min)"], ["plungeFeed", "Plunge feed (mm/min)"], ["spindleRpm", "Spindle speed (rpm)"],
        ] as const).map(([key, label]) => <div key={key}>
          <dt><label htmlFor={`cam-milling-${key}`}>{label}</label></dt>
          <dd><input id={`cam-milling-${key}`} type="number" step="any" value={process.cuttingConditions?.[key] ?? ""}
            onChange={(event) => changeCuttingConditions({ [key]: event.target.value })} /></dd>
        </div>)}</dl>
        <button type="button" onClick={() => exportOperations([process], process.id)}>Export APT-CL</button>
      </>}
      {setup && !selectedItem && !!setupOperations.length &&
        <button type="button" onClick={() => exportOperations(setupOperations, setup.name)}>Export setup APT-CL</button>}
      {aptError?.project === project && aptError.selection === selectedKey &&
        <ul role="alert">{aptError.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
      {process && !millingSettings && <ProfileExport key={`${documentId}/${process.id}/${process.contour?.entityId ?? ""}/${process.toolPositionId ?? ""}/${toolDiameter ?? ""}`}
        name={process.id} settings={process.profile} onChange={changeProfile} resolveFrame={resolveFrame} validateReferences={operationErrors}
        resolveOrientation={(setup, sketch) => process.orientation
          ? resolveOrientation(cad, documentId, setup, process.orientation, sketch) : undefined}
        hasContour={!!process.contour} hasTool={process.toolPositionId !== undefined} toolDiameter={toolDiameter}
        resolve={() => process.contour && cad.resolveCircularProfile?.(process.contour)} />}
      {setup && !selectedItem && <SetupEditor key={`${documentId}/${setup.id}`}
        setup={setup} cad={cad} edit={editSetup} select={selectContext} removeContext={removeContext}
        deleteSetup={deleteSetup} setupInUse={setupInUse} usedContexts={usedContexts} />}
      {errors.length > 0 && (
        <ul role="alert">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
      )}
    </div>
  );

  const timeline = (
    <ol className="cam-timeline" role="list" aria-label="Part history">
      {!project.setups.length && <li className="cam-timeline__empty">Create a setup to start the part history.</li>}
      {project.setups.map((item) => (
        <li key={item.id}>
          <button className="cam-timeline__tile" type="button" aria-pressed={!selectedItem && setup?.id === item.id}
            onClick={() => selectTile(`setup:${item.id}`)}>
            <PlanIcon kind="setup" />{item.name}
          </button>
        </li>
      ))}
      {plan.map((item) => {
        const operation = item.kind === "process"
          ? project.processes.find((candidate) => candidate.id === item.processId)
          : undefined;
        if (item.kind === "process" && !operation) return null;
        const label = item.kind === "process" ? machiningLabels[item.stage] : stageLabels[item.kind];
        const key = itemKey(item);
        return (
          <li key={key}>
            <button className="cam-timeline__tile" type="button" aria-pressed={selectedKey === key}
              onClick={() => selectTile(key)}>
              {item.kind === "process" ? <MillIcon size={18} /> : <PlanIcon kind={item.kind} />}
              {operation ? `${operation.name} · ${label}` : label}
            </button>
          </li>
        );
      })}
    </ol>
  );

  return { commands, properties, timeline, pickingSketch, pickingFace: pickingFace || pickingFacingFace };
}
