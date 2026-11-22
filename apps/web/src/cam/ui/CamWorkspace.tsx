import { useState } from "react";
import {
  addPlanStage, addProcess, addSetup, createProject, getProcessPlan, validateProject,
  type CamMachiningStage, type CamPlanItem, type CamPlanStage,
} from "@whittle/cam";
import type { CamCadAdapter } from "../cadAdapter";
import { demoMachine, demoTracks, trackKey } from "../machine";
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

export function useCamWorkspace(cad: CamCadAdapter, documentId: string | undefined, openProperties: () => void) {
  const [project, setProject] = useState(() => createProject("Manufacturing project"));
  const [selectedKey, setSelectedKey] = useState<string>();
  const [draftDocumentId, setDraftDocumentId] = useState(documentId);
  if (draftDocumentId !== documentId) {
    setDraftDocumentId(documentId);
    setProject(createProject("Manufacturing project"));
    setSelectedKey(undefined);
  }

  const plan = getProcessPlan(project);
  const selectedItem = plan.find((item) => itemKey(item) === selectedKey);
  const process = selectedItem?.kind === "process"
    ? project.processes.find((item) => item.id === selectedItem.processId)
    : undefined;
  const setupId = selectedItem?.kind === "process" ? process?.setupId : selectedItem?.setupId;
  const setup = project.setups.find((item) => item.id === setupId) ?? project.setups[0];
  const part = setup?.part ?? cad.getSelection()[0];
  const geometry = part && cad.resolveGeometry(part);
  const assignedTrack = process?.track;
  const track = assignedTrack && demoTracks.find((item) => trackKey(item) === trackKey(assignedTrack));
  const unit = track && demoMachine.executionUnits.find((item) => item.id === track.unitId);

  function createSetup() {
    if (!part || !geometry) return;
    setProject((current) => current.setups.length ? current : addSetup(current, {
      id: "setup-1", name: "Setup 1", part,
    }));
  }

  function createProfile() {
    if (!setup || !geometry) return;
    const number = project.processes.length + 1;
    const id = `profile-${number}`;
    const contour = cad.getSelection().find((ref) => ref.kind === "sketch")
      ?? (setup.part.kind === "sketch" ? setup.part : undefined);
    setProject((current) => addProcess(current, {
      id, name: `Profile ${number}`, setupId: setup.id, kind: "profile", contour,
    }));
    setSelectedKey(`process:${id}`);
  }

  function createStage(kind: CamPlanStage["kind"]) {
    if (!setup) return;
    const id = `stage-${plan.length + 1}`;
    setProject((current) => addPlanStage(current, { id, kind, setupId: setup.id }));
    setSelectedKey(`stage:${id}`);
  }

  function changeMachiningStage(stage: CamMachiningStage) {
    setProject((current) => ({
      ...current,
      processPlan: getProcessPlan(current).map((item) =>
        item.kind === "process" && itemKey(item) === selectedKey ? { ...item, stage } : item),
    }));
  }

  function changeTrack(key: string) {
    const assignment = demoTracks.find((item) => trackKey(item) === key);
    setProject((current) => ({
      ...current,
      processes: current.processes.map((item) => item.id === process?.id ? {
        ...item,
        track: assignment && { unitId: assignment.unitId, id: assignment.id },
      } : item),
    }));
  }

  function selectTile(key?: string) {
    setSelectedKey(key);
    openProperties();
  }

  const commands = [
    { id: "setup", label: "Create setup", icon: MillIcon, enabled: !!geometry && !setup, run: createSetup },
    { id: "profile", label: "Add profile", icon: MillIcon, enabled: !!setup && !!geometry, run: createProfile },
  ];
  const selectedStage = selectedItem && selectedItem.kind !== "process" ? selectedItem : undefined;
  const errors = validateProject(project);

  const properties = (
    <div className="cam-properties">
      <h2>{process?.name ?? (selectedStage && stageLabels[selectedStage.kind]) ?? setup?.name ?? manufacturingLabel}</h2>
      <p>{demoMachine.name} · {demoMachine.controller}</p>
      <dl>
        <dt>Part geometry</dt>
        <dd>{geometry?.name ?? (setup ? "Geometry unavailable" : "Select a body or sketch")}</dd>
        {selectedItem && <><dt>Setup</dt><dd>{setup?.name}</dd></>}
        {process && selectedItem?.kind === "process" && <>
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
      {process && cad.resolveCircularProfile && <ProfileExport key={process.id}
        name={process.id} resolve={() => process.contour && cad.resolveCircularProfile?.(process.contour)} />}
      {setup && !selectedItem && (
        <div className="cam-properties__actions">
          <button type="button" onClick={() => createStage("transfer")}>Add transfer</button>
          <button type="button" onClick={() => createStage("ejection")}>Add ejection</button>
        </div>
      )}
      {errors.length > 0 && (
        <ul role="alert">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
      )}
    </div>
  );

  const timeline = (
    <ol className="cam-timeline" role="list" aria-label="Part history">
      {!setup && <li className="cam-timeline__empty">Select a body or sketch and create a setup.</li>}
      {setup && (
        <li>
          <button className="cam-timeline__tile" type="button" aria-pressed={!selectedItem}
            onClick={() => selectTile()}>
            <PlanIcon kind="setup" />{setup.name}
          </button>
        </li>
      )}
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

  return { commands, properties, timeline };
}
