import { castDraft } from "immer";
import { CAM_TOOL_COMPONENT_ROLES, type CamToolComponentRole, type CamToolPosition } from "@whittle/cam";
import {
  activeEnd, bodyIdsBefore, documentEvaluator, type MoveFeature, makeCsys, makeMove, removeCamToolGeometry, toolForBody, uid,
} from "@whittle/core";
import { useState } from "react";
import { addToolComponentFeatures, importModel, startMove } from "../../state/actions";
import { commitSession, deleteFeature, editFeature, findFeature, isNarrow, mutate, selectedBodyId, toast, useApp } from "../../state/store";
import { DeferredInput } from "../../ui/DeferredInput";
import { Icon } from "../../ui/icons";

function addTool() {
  commitSession();
  const { doc } = useApp.getState();
  const project = doc.manufacturing;
  if (!project) return;
  const positions = project.toolPositions ?? [];
  let number = 1;
  while (positions.some((tool) => tool.number === number)) number++;
  const tip = { ...makeCsys(doc), name: "TIP" };
  const tool: CamToolPosition = {
    id: uid("tool"), number, name: "Tool", tipCsysId: tip.id, components: [],
    placement: { position: ["0", "0", "0"], rotation: ["0", "0", "0"] },
  };
  mutate("Add tool position", (draft) => {
    draft.manufacturing = castDraft({ ...project, toolPositions: [...positions, tool] });
    draft.features.splice(activeEnd(draft), 0, tip);
    if (draft.rollback !== null) draft.rollback++;
  });
  selectTool({ kind: "position", toolId: tool.id });
}

function editTool(id: string, label: string, edit: (tool: CamToolPosition) => CamToolPosition, mergeKey?: string) {
  commitSession();
  mutate(label, (draft) => {
    const project = draft.manufacturing;
    if (project) draft.manufacturing = castDraft({
      ...project, toolPositions: project.toolPositions?.map((tool) => tool.id === id ? edit(tool) : tool),
    });
  }, mergeKey);
}

function copyBodyIntoTool(id: string, role: CamToolComponentRole, bodyId = selectedBodyId()) {
  if (!bodyId) return;
  commitSession();
  const { doc } = useApp.getState();
  const tool = doc.manufacturing?.toolPositions?.find((item) => item.id === id);
  if (!tool) return;
  const source = findFeature(doc, bodyId, "import");
  const name = doc.bodies[bodyId]?.name ?? "Component";
  if (source) {
    const copy = { ...source, id: uid("im"), name };
    mutate("Add component body", (d) => {
      d.bodies[copy.id] = { name, color: doc.bodies[bodyId]?.color ?? "#afbdcd", visible: true };
      addToolComponentFeatures(d, { id, role }, [copy]);
    });
    return;
  }
  const at = doc.features.findIndex((f) => f.id === tool.tipCsysId);
  if (toolForBody(doc, bodyId) || !bodyIdsBefore(doc, at).includes(bodyId)) {
    return toast("info", "Select an imported body or a CAM body built before TIP.");
  }
  const copy = makeMove(doc, bodyId);
  if (copy.type !== "move") return;
  copy.copy = true;
  copy.name = name;
  mutate("Add component body", (d) => {
    d.bodies[copy.id] = { name, color: doc.bodies[bodyId]?.color ?? "#afbdcd", visible: true };
    addToolComponentFeatures(d, { id, role }, [copy]);
  });
}

function toolLabel(tool: CamToolPosition) {
  return `T${String(tool.number).padStart(2, "0")} — ${tool.name}`;
}

function selectTool(target: NonNullable<ReturnType<typeof useApp.getState>["camToolSelection"]>) {
  const session = useApp.getState().session;
  if (target.kind !== "tip" || session?.featureId !== target.tipId) commitSession();
  if (target.kind === "tip") editFeature(target.tipId);
  useApp.setState({
    camToolSelection: target,
    panelOpen: true,
    ...(target.kind === "component" ? { selection: [{ kind: "body", bodyId: target.bodyId }] } : {}),
    ...(isNarrow() ? { browserOpen: false } : {}),
  });
}

function ToolPositionRow({ tool }: { tool: CamToolPosition }) {
  const [expanded, setExpanded] = useState(false);
  const doc = useApp((s) => s.session?.base ?? s.doc);
  const selected = useApp((s) => s.camToolSelection);
  const active = doc.features.slice(0, activeEnd(doc)).some((f) => f.id === tool.tipCsysId);
  const positionSelected = selected?.kind === "position" && selected.toolId === tool.id;
  return (
    <div className="cam-tool">
      <div className={`tree__row ${positionSelected ? "is-selected" : ""}`}>
        <button className="cam-tool__expand" type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${toolLabel(tool)}`}
          aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={14} />
        </button>
        <button className="tree__main" type="button" aria-pressed={positionSelected} onClick={() => {
          setExpanded(true);
          selectTool({ kind: "position", toolId: tool.id });
        }}><span className="tree__name">{toolLabel(tool)}</span></button>
      </div>
      {expanded && <div className="cam-tool__children">
        {tool.components.map(({ bodyId }) => {
          const isSelected = selected?.kind === "component" && selected.bodyId === bodyId;
          return (
            <button key={bodyId} className={`tree__row ${isSelected ? "is-selected" : ""}`} type="button"
              aria-pressed={isSelected} onClick={() => selectTool({ kind: "component", toolId: tool.id, bodyId })}>
              <Icon name="body" size={16} /><span className="tree__name">{doc.bodies[bodyId]?.name ?? bodyId}</span>
            </button>
          );
        })}
        <button className={`tree__row ${selected?.kind === "tip" && selected.tipId === tool.tipCsysId ? "is-selected" : ""}`}
          disabled={!active} type="button" aria-pressed={selected?.kind === "tip" && selected.tipId === tool.tipCsysId}
          onClick={() => selectTool({ kind: "tip", toolId: tool.id, tipId: tool.tipCsysId })}>
          <Icon name="origin" size={16} /><span className="tree__name">TIP</span>
        </button>
      </div>}
    </div>
  );
}

export function ToolPositions() {
  const positions = useApp((s) => s.doc.manufacturing?.toolPositions);
  return (
    <section className="tree__section cam-tools" aria-label="Tool positions">
      {positions?.length ? [...positions].sort((a, b) => a.number - b.number).map((tool) =>
        <ToolPositionRow key={tool.id} tool={tool} />) : <p className="tree__empty">No tool positions</p>}
    </section>
  );
}

function PositionProperties({ tool }: { tool: CamToolPosition }) {
  const doc = useApp((s) => s.doc);
  const selectedBody = useApp((s) => s.selection.find((pick) =>
    pick.kind === "body" || pick.kind === "face" || pick.kind === "edge")?.bodyId);
  const [role, setRole] = useState<CamToolComponentRole>("cutter");
  const isolated = useApp((s) => s.isolatedToolId === tool.id);
  const hasGeometry = useApp((s) => s.builtDoc === s.doc
    && s.regen?.bodies.some((body) => tool.components.some(({ bodyId }) => bodyId === body.id)));
  const active = doc.features.slice(0, activeEnd(doc)).some((f) => f.id === tool.tipCsysId);
  return (
    <>
      <h2>{toolLabel(tool)}</h2>
      <button type="button" className="btn btn--small" disabled={!hasGeometry || isolated}
        onClick={() => useApp.setState({ isolatedToolId: tool.id, selection: [], hover: null })}>Isolate Tool</button>
      <div className="cam-tool__fields">
        <label>Tool number <DeferredInput className="input input--small" type="number" min="1" step="1" value={String(tool.number)}
          onCommit={(value) => {
            const number = Number(value);
            if (!Number.isSafeInteger(number) || number < 1 || doc.manufacturing?.toolPositions?.some((item) => item.id !== tool.id && item.number === number)) {
              toast("warn", "Enter a unique positive tool number.");
              return;
            }
            editTool(tool.id, "Change tool number", (item) => ({ ...item, number }));
          }} /></label>
        <label>Name <DeferredInput className="input input--small" value={tool.name} onCommit={(value) => {
          if (value.trim()) editTool(tool.id, "Rename tool", (item) => ({ ...item, name: value.trim() }), `tool-name:${tool.id}`);
        }} /></label>
      </div>
      <div className="cam-tool__actions">
        <select aria-label="New component role" value={role} onChange={(event) => setRole(event.target.value as CamToolComponentRole)}>
          {CAM_TOOL_COMPONENT_ROLES.map((option) => <option key={option}>{option}</option>)}
        </select>
        <button type="button" className="btn btn--small" disabled={!active} onClick={() => importModel({ id: tool.id, role })}>Insert Body</button>
        <button type="button" className="btn btn--small" disabled={!active || !selectedBody}
          onClick={() => copyBodyIntoTool(tool.id, role)}>Add selected body</button>
      </div>
      <details className="cam-tool__placement">
        <summary>Move tool</summary>
        {(["position", "rotation"] as const).map((field) => (
          <fieldset key={field}>
            <legend>{field === "position" ? `Translation (${doc.units})` : "Rotation (degrees)"}</legend>
            <div className="cam-tool__axes">
              {(["X", "Y", "Z"] as const).map((axis, index) => (
                <label key={axis}>{axis}<DeferredInput className="input input--small"
                  aria-label={`Tool ${field} ${axis}`} value={tool.placement[field][index]!} onCommit={(value) => {
                    editTool(tool.id, "Move tool", (item) => {
                      const kind = field === "position" ? "length" : "angle";
                      try {
                        documentEvaluator(useApp.getState().doc).num(value, kind);
                      } catch {
                        toast("warn", `Enter a valid ${kind} for the tool move.`);
                        return item;
                      }
                      const values = [...item.placement[field]] as [string, string, string];
                      values[index] = value;
                      return { ...item, placement: { ...item.placement, [field]: values } };
                    }, `tool-placement:${tool.id}:${field}:${axis}`);
                  }} /></label>
              ))}
            </div>
          </fieldset>
        ))}
      </details>
      <details className="cam-tool__placement" open>
        <summary>Cutting definition</summary>
        <label>Flat endmill diameter (mm)
          <DeferredInput className="input input--small" type="number" min="0" step="any"
            value={tool.cutting ? String(tool.cutting.diameter) : ""} onCommit={(value) => {
              const diameter = Number(value);
              if (value.trim() && (!Number.isFinite(diameter) || diameter <= 0)) {
                toast("warn", "Enter a positive cutting diameter.");
                return;
              }
              editTool(tool.id, "Edit cutting definition", (item) => ({
                ...item, cutting: value.trim() ? { kind: "flat-endmill", diameter } : undefined,
              }));
            }} />
        </label>
      </details>
      <button type="button" className="btn btn--small" onClick={() => {
        commitSession();
        mutate("Delete tool position", (d) => {
          removeCamToolGeometry(d, tool);
          if (d.manufacturing) d.manufacturing.toolPositions = d.manufacturing.toolPositions?.filter((item) => item.id !== tool.id);
        });
        useApp.setState({ selection: [], camToolSelection: { kind: "list" } });
      }}>Delete Tool</button>
    </>
  );
}

function ComponentProperties({ tool, bodyId, role }: { tool: CamToolPosition; bodyId: string; role: CamToolComponentRole }) {
  const doc = useApp((s) => s.doc);
  const regen = useApp((s) => s.doc === s.builtDoc ? s.regen : null);
  const body = doc.bodies[bodyId];
  const name = body?.name ?? bodyId;
  const available = regen?.bodies.some((item) => item.id === bodyId);
  const issue = regen?.status.find((item) => item.id === bodyId && item.state === "error");
  const features = doc.features.slice(0, activeEnd(doc));
  const active = features.some((f) => f.id === tool.tipCsysId);
  const placements = features.filter((f): f is MoveFeature =>
    f.type === "move" && !f.suppressed && (f.id === bodyId || (!f.copy && f.bodyId === bodyId)));
  const datumName = (id: string | undefined) => id ? findFeature(doc, id)?.name ?? "Unavailable CSYS" : "Unspecified CSYS";
  return (
    <>
      <h2>{name}</h2>
      <p>{toolLabel(tool)}</p>
      {issue?.message && <p role="alert">{issue.message}</p>}
      <div className="cam-tool__actions">
        <label>Role <select aria-label="Role" value={role} onChange={(event) => {
          const role = event.target.value as CamToolComponentRole;
          editTool(tool.id, "Change component role", (item) => ({
            ...item, components: item.components.map((component) => component.bodyId === bodyId ? { ...component, role } : component),
          }));
        }}>
          {CAM_TOOL_COMPONENT_ROLES.map((option) => <option key={option}>{option}</option>)}
        </select></label>
        <label><input type="checkbox" checked={body?.visible !== false} disabled={!body}
          onChange={(event) => {
            const visible = event.target.checked;
            mutate("Toggle tool component visibility", (d) => {
              const meta = d.bodies[bodyId];
              if (meta) meta.visible = visible;
            });
          }} /> Visible</label>
      </div>
      <h3>Placement</h3>
      {placements.length ? <ul>{placements.map((move) => (
        <li key={move.id}>{move.placement
          ? `${datumName(move.placement.from)} → ${datumName(move.placement.to)}`
          : `X ${move.translate[0]}, Y ${move.translate[1]}, Z ${move.translate[2]} · ${move.axis.toUpperCase()} rotation ${move.angle}`}</li>
      ))}</ul> : <p>As inserted</p>}
      <div className="cam-tool__actions">
        <button className="btn btn--small" type="button" disabled={!available || !active} onClick={() => startMove(bodyId)}>Move</button>
        <button className="btn btn--small" type="button" disabled={!active || !findFeature(doc, bodyId, "import")}
          title="Copy the imported body into this tool" onClick={() => copyBodyIntoTool(tool.id, role, bodyId)}>Copy</button>
        <button className="btn btn--small" type="button" onClick={() => {
          deleteFeature(bodyId);
          selectTool({ kind: "position", toolId: tool.id });
        }}>Remove</button>
      </div>
    </>
  );
}

export function ToolProperties() {
  const selection = useApp((s) => s.camToolSelection);
  const tool = useApp((s) => s.doc.manufacturing?.toolPositions?.find((item) =>
    selection && selection.kind !== "list" && item.id === selection.toolId));
  const tipStatus = useApp((s) => s.builtDoc === s.doc && selection?.kind === "tip"
    ? s.regen?.status.find((item) => item.id === selection.tipId) : undefined);
  const component = selection?.kind === "component" && tool?.components.find((item) => item.bodyId === selection.bodyId);
  return (
    <div className="cam-properties">
      {tool && selection?.kind === "tip" && <>
        <h2>TIP</h2>
        <p>{toolLabel(tool)}</p>
        {tipStatus?.message && <p role={tipStatus.state === "error" ? "alert" : "status"}>{tipStatus.message}</p>}
        <button className="btn btn--small" type="button" onClick={() => selectTool(selection)}>Edit TIP</button>
      </>}
      {tool && selection?.kind !== "tip" && (component
        ? <ComponentProperties key={component.bodyId} tool={tool} {...component} />
        : <PositionProperties key={tool.id} tool={tool} />)}
      {!tool && <h2>Tool positions</h2>}
      {(!tool || selection?.kind === "position") && <div className="cam-tool__actions">
        <button className="btn btn--small" type="button" onClick={addTool}>Add Tool Position</button>
      </div>}
    </div>
  );
}
