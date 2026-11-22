import { useState } from "react";
import { uid } from "@whittle/core";
import type { CamBodyRole, CamSetup, CamWorkpieceContext } from "@whittle/cam";
import type { CamCadAdapter } from "../cadAdapter";

const roleLabels = { workpiece: "Workpiece", stock: "Stock", fixture: "Fixture" } satisfies Record<CamBodyRole, string>;

export function SetupEditor({ setup, cad, edit, select, deleteSetup, setupInUse, usedContexts, removeContext }: {
  setup: CamSetup;
  cad: CamCadAdapter;
  edit: (update: (current: CamSetup) => CamSetup, label: string, mergeKey?: string) => void;
  select: (id?: string) => void;
  deleteSetup: () => void;
  setupInUse: boolean;
  usedContexts: ReadonlySet<string | undefined>;
  removeContext: (id: string) => boolean;
}) {
  const [editingId, setEditingId] = useState<string>();
  const [role, setRole] = useState<CamBodyRole>("workpiece");
  const datums = cad.getCoordinateSystems();
  const bodies = cad.getSelection().flatMap((body) => body.kind === "body" && cad.resolveGeometry(body)
    ? [{ ...body, kind: "body" as const }]
    : []);
  const contexts = setup.contexts ?? [];
  const context = contexts.find((item) => item.id === editingId);
  const frame = context?.frame;
  const csysId = frame?.kind === "native" ? frame.csysId : "";
  const additions = bodies.filter((body) => !context?.bodies.some((assignment) =>
    assignment.body.documentId === body.documentId && assignment.body.entityId === body.entityId && assignment.role === role));

  function editContext(update: (current: CamWorkpieceContext) => CamWorkpieceContext, label: string, mergeKey?: string) {
    edit((current) => ({
      ...current, contexts: current.contexts?.map((item) => item.id === context?.id ? update(item) : item),
    }), label, mergeKey);
  }

  function openContext(id: string) {
    setRole("workpiece");
    setEditingId(id);
    select(id);
  }

  function frameName(frame: CamWorkpieceContext["frame"]) {
    if (frame.kind === "legacy-sketch") return "Sketch origin and axes (migrated)";
    if (frame.kind === "legacy-world") return "Document origin (migrated)";
    if (!frame.csysId) return "No CSYS selected";
    return datums.find((datum) => datum.id === frame.csysId)?.name ?? "Coordinate system unavailable";
  }

  function addContext() {
    const id = uid("context");
    const part = setup.part;
    const workpieces = !bodies.length && part?.kind === "body"
      ? [{ ...part, kind: "body" as const }] : bodies;
    let number = contexts.length + 1;
    while (contexts.some((item) => item.name === `Context ${number}`)) number += 1;
    const next: CamWorkpieceContext = {
      id, name: contexts.length ? `Context ${number}` : "Main",
      frame: { kind: "native", csysId: datums[0]?.id ?? "" },
      bodies: workpieces.map((body) => ({ body, role: "workpiece" })),
    };
    edit((current) => ({ ...current, contexts: [...(current.contexts ?? []), next] }), "Add workpiece context");
    openContext(id);
  }

  return (
    <>
      <dl>
        <dt><label htmlFor="cam-setup-name">Setup name</label></dt>
        <dd><input id="cam-setup-name" value={setup.name}
          onChange={(event) => edit((current) => ({ ...current, name: event.target.value }), "Rename setup", `cam:${setup.id}:name`)} /></dd>
      </dl>
      <section className="cam-setup__section" aria-labelledby="cam-contexts-heading">
        <h3 id="cam-contexts-heading">Workpiece contexts</h3>
        <ul className="cam-setup__rows" aria-labelledby="cam-contexts-heading">
          {contexts.map((item) => (
            <li key={item.id}>
              <div><strong>{item.name}</strong><div>{frameName(item.frame)}</div></div>
              <button type="button" aria-label={`Edit ${item.name}`} aria-expanded={item.id === editingId}
                aria-controls={context ? "cam-context-properties" : undefined}
                onClick={() => openContext(item.id)}>Edit</button>
            </li>
          ))}
        </ul>
        <div className="cam-properties__actions">
          <button type="button" onClick={addContext}>Add Context</button>
        </div>
      </section>
      {context && <section id="cam-context-properties" className="cam-setup__section"
        aria-labelledby="cam-context-properties-heading">
        <h3 id="cam-context-properties-heading">Context properties</h3>
        <dl>
          <dt><label htmlFor="cam-context-name">Context name</label></dt>
          <dd><input id="cam-context-name" value={context.name}
            onChange={(event) => editContext((current) => ({ ...current, name: event.target.value }), "Rename workpiece context", `cam:${context.id}:name`)} /></dd>
          <dt><label htmlFor="cam-context-csys">Context CSYS</label></dt>
          <dd><select id="cam-context-csys" value={csysId}
            onChange={(event) => editContext((current) => ({
              ...current, frame: { kind: "native", csysId: event.target.value },
            }), "Change context coordinate system")}>
            {!csysId && <option value="" disabled>{frameName(context.frame)}</option>}
            {csysId && !datums.some((datum) => datum.id === csysId) && <option value={csysId}>Coordinate system unavailable</option>}
            {datums.map((datum) => <option key={datum.id} value={datum.id}>{datum.name}</option>)}
          </select></dd>
        </dl>
        <h4>Body assignments</h4>
        {context.bodies.length > 0 && <ul className="cam-setup__rows" aria-label="Assigned bodies">
          {context.bodies.map(({ body, role }, index) => {
            const label = cad.resolveGeometry(body)?.name ?? body.entityId;
            return <li key={JSON.stringify([body.documentId, body.entityId, role])}>
              <span>{label} · <span>{roleLabels[role]}</span></span>
              <button type="button" aria-label={`Remove ${label} as ${role}`}
                onClick={() => editContext((current) => ({ ...current, bodies: current.bodies.filter((_, i) => i !== index) }),
                  "Remove body assignment")}>Remove</button>
            </li>;
          })}
        </ul>}
        <div className="cam-properties__actions">
          <select aria-label="Selected body role" value={role} onChange={(event) => setRole(event.target.value as CamBodyRole)}>
            {Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button type="button" disabled={!additions.length} onClick={() => editContext((current) => ({
            ...current, bodies: [...current.bodies, ...additions.map((body) => ({ body, role }))],
          }), "Assign selected bodies")}>Assign selected bodies</button>
        </div>
        {!bodies.length && <p>Select a CAD body to assign it.</p>}
        {usedContexts.has(context.id) && <p id="cam-context-in-use">Reassign the operations using this context before removing it.</p>}
        <div className="cam-properties__actions cam-setup__footer">
          <button type="button" disabled={usedContexts.has(context.id)}
            aria-describedby={usedContexts.has(context.id) ? "cam-context-in-use" : undefined}
            onClick={() => {
              if (removeContext(context.id)) setEditingId(undefined);
            }}>Remove Context</button>
          <button type="button" onClick={() => setEditingId(undefined)}>Done</button>
        </div>
      </section>}
      <div className="cam-properties__actions cam-setup__footer">
        <button type="button" disabled={setupInUse} onClick={deleteSetup}>Delete setup</button>
      </div>
      {setupInUse && <p>This setup is used in the part history.</p>}
    </>
  );
}
