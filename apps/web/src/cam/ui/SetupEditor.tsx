import { useState } from "react";
import { uid } from "@whittle/core";
import type { CamBodyRole, CamSetup, CamWorkpieceContext } from "@whittle/cam";
import type { CamCadAdapter } from "../cadAdapter";

const roles = ["workpiece", "stock", "fixture"] as const;

export function SetupEditor({ setup, context, cad, edit, select, deleteSetup, setupInUse, usedContexts }: {
  setup: CamSetup;
  context?: CamWorkpieceContext;
  cad: CamCadAdapter;
  edit: (update: (current: CamSetup) => CamSetup, label: string, mergeKey?: string) => void;
  select: (id?: string) => void;
  deleteSetup: () => void;
  setupInUse: boolean;
  usedContexts: ReadonlySet<string | undefined>;
}) {
  const [newCsys, setNewCsys] = useState("");
  const [role, setRole] = useState<CamBodyRole>("workpiece");
  const datums = cad.getCoordinateSystems();
  const bodies = cad.getSelection().flatMap((body) => body.kind === "body" && cad.resolveGeometry(body)
    ? [{ ...body, kind: "body" as const }]
    : []);
  const contexts = setup.contexts ?? [];
  const frame = context?.frame;
  const csysId = frame?.kind === "native" ? frame.csysId : "";
  const additions = bodies.filter((body) => !context?.bodies.some((assignment) =>
    assignment.body.documentId === body.documentId && assignment.body.entityId === body.entityId && assignment.role === role));

  function editContext(update: (current: CamWorkpieceContext) => CamWorkpieceContext, label: string, mergeKey?: string) {
    edit((current) => ({
      ...current, contexts: current.contexts?.map((item) => item.id === context?.id ? update(item) : item),
    }), label, mergeKey);
  }

  function addContext() {
    if (!datums.some((datum) => datum.id === newCsys)) return;
    const id = uid("context");
    const part = setup.part;
    const workpieces = !bodies.length && part?.kind === "body"
      ? [{ ...part, kind: "body" as const }] : bodies;
    const next: CamWorkpieceContext = {
      id, name: contexts.length ? `Context ${contexts.length + 1}` : "Main",
      frame: { kind: "native", csysId: newCsys },
      bodies: workpieces.map((body) => ({ body, role: "workpiece" })),
    };
    edit((current) => ({ ...current, contexts: [...(current.contexts ?? []), next] }), "Add workpiece context");
    select(id);
  }

  return (
    <>
      <dl>
        <dt><label htmlFor="cam-setup-name">Setup name</label></dt>
        <dd><input id="cam-setup-name" value={setup.name}
          onChange={(event) => edit((current) => ({ ...current, name: event.target.value }), "Rename setup", `cam:${setup.id}:name`)} /></dd>
        <dt><label htmlFor="cam-setup-context">Workpiece context</label></dt>
        <dd><select id="cam-setup-context" value={context?.id ?? ""} onChange={(event) => select(event.target.value)}>
          {!context && <option value="">No workpiece contexts</option>}
          {contexts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></dd>
      </dl>
      {context && <>
        <dl>
          <dt><label htmlFor="cam-context-name">Context name</label></dt>
          <dd><input id="cam-context-name" value={context.name}
            onChange={(event) => editContext((current) => ({ ...current, name: event.target.value }), "Rename workpiece context", `cam:${context.id}:name`)} /></dd>
          <dt><label htmlFor="cam-context-csys">Context CSYS</label></dt>
          <dd><select id="cam-context-csys" value={csysId}
            onChange={(event) => editContext((current) => ({
              ...current, frame: { kind: "native", csysId: event.target.value },
            }), "Change context coordinate system")}>
            {frame?.kind !== "native" && <option value="" disabled>
              {frame?.kind === "legacy-sketch" ? "Sketch origin and axes (migrated)" : "Document origin (migrated)"}
            </option>}
            {csysId && !datums.some((datum) => datum.id === csysId) && <option value={csysId}>Coordinate system unavailable</option>}
            {datums.map((datum) => <option key={datum.id} value={datum.id}>{datum.name}</option>)}
          </select></dd>
          <dt><label htmlFor="cam-body-role">Selected body role</label></dt>
          <dd><select id="cam-body-role" value={role} onChange={(event) => setRole(event.target.value as CamBodyRole)}>
            {roles.map((item) => <option key={item}>{item}</option>)}
          </select></dd>
        </dl>
        {context.bodies.length > 0 && <ul aria-label="Assigned bodies">
          {context.bodies.map(({ body, role }, index) => {
            const label = cad.resolveGeometry(body)?.name ?? body.entityId;
            return <li key={JSON.stringify([body.documentId, body.entityId, role])}>
              {label} · {role}{" "}
              <button type="button" aria-label={`Remove ${label} as ${role}`}
                onClick={() => editContext((current) => ({ ...current, bodies: current.bodies.filter((_, i) => i !== index) }),
                  "Remove body assignment")}>Remove</button>
            </li>;
          })}
        </ul>}
        <div className="cam-properties__actions">
          <button type="button" disabled={!additions.length} onClick={() => editContext((current) => ({
            ...current, bodies: [...current.bodies, ...additions.map((body) => ({ body, role }))],
          }), "Assign selected bodies")}>Assign selected bodies</button>
          <button type="button" disabled={usedContexts.has(context.id)} onClick={() => {
            edit((current) => ({ ...current, contexts: current.contexts?.filter((item) => item.id !== context.id) }),
              "Delete workpiece context");
            select();
          }}>Delete context</button>
        </div>
        {usedContexts.has(context.id) && <p>Reassign operations before deleting this context.</p>}
      </>}
      <dl>
        <dt><label htmlFor="cam-new-context-csys">New context CSYS</label></dt>
        <dd><select id="cam-new-context-csys" value={datums.some((datum) => datum.id === newCsys) ? newCsys : ""}
          onChange={(event) => setNewCsys(event.target.value)}>
          <option value="">{datums.length ? "Select a native CSYS" : "Create a CSYS in the CAD workspace"}</option>
          {datums.map((datum) => <option key={datum.id} value={datum.id}>{datum.name}</option>)}
        </select></dd>
      </dl>
      <div className="cam-properties__actions">
        <button type="button" disabled={!datums.some((datum) => datum.id === newCsys)} onClick={addContext}>Add context</button>
        <button type="button" disabled={setupInUse} onClick={deleteSetup}>Delete setup</button>
      </div>
      {setupInUse && <p>This setup is used in the part history.</p>}
    </>
  );
}
