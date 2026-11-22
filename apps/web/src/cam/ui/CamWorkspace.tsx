import { useEffect, useState } from "react";
import {
  CAM_WORLD, addProcess, addSetup, getProcessPlan, validateOperationTooling, validateProject,
  type CamGeometryRef, type CamMachiningStage, type CamPlanItem, type CamProject, type CamSetup, type CircularProfileSettings,
} from "@whittle/cam";
import type { CamCadAdapter } from "../cadAdapter";
import { demoMachine, demoTracks, trackKey } from "../machine";
import { uid } from "@whittle/core";
import { SetupEditor } from "./SetupEditor";
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
  canPickSketch: boolean,
  startSketchPick: () => void,
) {
  const [sketchPick, setSketchPick] = useState<{ documentId?: string; key?: string }>();
  const [selection, setSelection] = useState<{ documentId?: string; key?: string }>({});
  const [contextSelection, setContextSelection] = useState<{ documentId?: string; setupId?: string; id?: string }>({});
  const selectedKey = selection.documentId === documentId ? selection.key : undefined;
  const setSelectedKey = (key?: string) => {
    setSketchPick(undefined);
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
  const frame = context?.frame;
  function resolveFrame() {
    if (frame?.kind === "native") return cad.resolveCoordinateSystem(frame.csysId);
    if (frame?.kind === "legacy-world") return CAM_WORLD;
    if (frame?.kind === "legacy-sketch" && frame.sketch) return cad.resolveSketchFrame(frame.sketch);
  }

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
  const pickingSketch = !!process && canPickSketch && !!sketchPick
    && sketchPick.documentId === documentId && sketchPick.key === selectedKey;
  const selectedSketchValid = !!selectedSketch && !!cad.resolveCircularProfile?.(selectedSketch);

  function changeContour(contour: CamGeometryRef | undefined) {
    if (!process) return;
    setProject((current) => ({
      ...current,
      processes: current.processes.map((item) => item.id === process.id ? { ...item, contour } : item),
    }), contour ? "Assign operation profile sketch" : "Remove operation profile sketch");
    setSketchPick(undefined);
  }

  useEffect(() => {
    if (pickingSketch && selectedSketchValid) {
      changeContour(selectedSketch);
      openProperties();
    } else if (!canPickSketch && sketchPick) {
      setSketchPick(undefined);
    }
  });

  useEffect(() => {
    if (!pickingSketch) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSketchPick(undefined);
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [pickingSketch]);

  const tools = project.toolPositions ?? [];
  const operationTool = tools.find((tool) => tool.id === process?.toolPositionId);
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

  function createProfile() {
    if (!setup || !context) return;
    const number = project.processes.length + 1;
    const id = uid("profile");
    const contour = selectedSketch
      ?? (setup.part?.kind === "sketch" ? setup.part : undefined);
    setProject((current) => addProcess(current, {
      id, name: `Profile ${number}`, setupId: setup.id, contextId: context.id, kind: "profile", contour,
    }), "Add circular profile");
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

  function changeProfile(settings: Partial<CircularProfileSettings>) {
    if (!process) return;
    setProject((current) => ({
      ...current,
      processes: current.processes.map((item) => item.id === process.id
        ? { ...item, profile: { ...item.profile, ...settings } }
        : item),
    }), "Edit circular profile", `cam:${process.id}:${Object.keys(settings)[0]}`);
  }

  function selectTile(key?: string) {
    setSelectedKey(key);
    openProperties();
  }

  const commands = [
    { id: "setup", label: "Create setup", icon: MillIcon, enabled: true, run: createSetup },
    { id: "profile", label: "Add profile", icon: MillIcon, enabled: !!setup && !!context, run: createProfile },
  ];
  const selectedStage = selectedItem && selectedItem.kind !== "process" ? selectedItem : undefined;
  const errors = [...validateProject(project), ...sourceErrors];
  const datums = cad.getCoordinateSystems();
  for (const item of project.processes) {
    if (item.contour && !cad.resolveGeometry(item.contour)) errors.push(`${item.name} references a missing profile sketch.`);
  }
  const operationErrors = () => [
    ...(process ? validateOperationTooling(process, tools) : []),
    ...(operationTool && !cad.resolveCoordinateSystem(operationTool.tipCsysId) ? ["Resolve the selected tool's TIP before exporting."] : []),
    ...(operationTool && !operationTool.cutting ? ["Define the selected tool's cutting diameter before exporting."] : []),
    ...(context?.bodies ?? []).flatMap(({ body, role }) =>
      cad.resolveGeometry(body) ? [] : [`The ${role} body (${body.entityId}) is unavailable.`]),
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
          <dt>Profile sketch</dt>
          <dd>{contourName ?? (process.contour ? "Unavailable" : "Unassigned")}</dd>
        </dl>
        <div className="cam-properties__actions">
          <button type="button" aria-pressed={pickingSketch} onClick={() => {
            if (pickingSketch) setSketchPick(undefined);
            else {
              startSketchPick();
              setSketchPick({ documentId, key: selectedKey });
            }
          }}>{pickingSketch ? "Cancel Sketch Pick" : process.contour ? "Replace Sketch" : "Pick Sketch"}</button>
          {process.contour && <button type="button" onClick={() => changeContour(undefined)}>Remove Sketch</button>}
        </div>
        {pickingSketch && <p role="status">{selectedSketch && !selectedSketchValid
          ? "Choose a built sketch with one circle."
          : "Click a sketch in the 3D view or Browser."}</p>}
      </>}
      {process && <ProfileExport key={`${documentId}/${process.id}/${process.contour?.entityId ?? ""}/${process.toolPositionId ?? ""}/${operationTool?.cutting?.diameter ?? ""}`}
        name={process.id} settings={process.profile} onChange={changeProfile} resolveFrame={resolveFrame} validateReferences={operationErrors}
        hasContour={!!process.contour} hasTool={process.toolPositionId !== undefined} toolDiameter={operationTool?.cutting?.diameter}
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

  return { commands, properties, timeline, pickingSketch };
}
