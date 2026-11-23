import type { CamOrientation } from "@whittle/cam";
import type { CamCadAdapter } from "../cadAdapter";

export function OperationOrientation({ cad, documentId, orientation, sketchDefault, pickingFace, canPickFace, onChange, onPickFace, onCancelFace }: {
  cad: CamCadAdapter;
  documentId?: string;
  orientation?: CamOrientation;
  sketchDefault: boolean;
  pickingFace: boolean;
  canPickFace: boolean;
  onChange(orientation: CamOrientation): void;
  onPickFace(): void;
  onCancelFace(): void;
}) {
  const sources = [
    ...(cad.getDatumPlanes?.() ?? []).map(({ id, name }) => ({ kind: "plane" as const, id, label: `Datum plane · ${name}` })),
    ...cad.getCoordinateSystems().map(({ id, name }) => ({ kind: "csys" as const, id, label: `Coordinate system · ${name}` })),
  ];
  const flip = orientation?.flip ?? false;
  const sourceKey = (kind: string, id: string) => `${kind}:${id}`;
  const saved = orientation && orientation.kind !== "setup" && orientation.kind !== "sketch" ? orientation : undefined;
  const current = !saved ? sketchDefault && (!orientation || orientation.kind === "sketch") ? "sketch" : "setup" : saved.kind === "face" ? "face"
    : saved.documentId === documentId ? sourceKey(saved.kind, saved.entityId) : "missing";
  const sourceListed = sources.some(({ kind, id }) => sourceKey(kind, id) === current);

  return <>
    <dt><label htmlFor="cam-orientation">Machining orientation</label></dt>
    <dd><select id="cam-orientation" value={pickingFace ? "pick-face" : current} onChange={(event) => {
      const key = event.target.value;
      if (key === "pick-face") onPickFace();
      if (key === "face") onCancelFace();
      if (key === "sketch") onChange({ kind: "sketch", flip });
      if (key === "setup") onChange({ kind: "setup", flip });
      if (!documentId) return;
      const datum = sources.find(({ kind, id }) => sourceKey(kind, id) === key);
      if (datum) onChange({ kind: datum.kind, documentId, entityId: datum.id, flip });
    }}>
      {sketchDefault && <option value="sketch">Sketch normal</option>}
      <option value="setup">Setup Z</option>
      {saved?.kind === "face" && <option value="face">
        {saved.documentId === documentId && cad.resolveFloor?.(saved.face) ? "Planar face normal" : "Planar face unavailable"}
      </option>}
      <option value="pick-face" disabled={!canPickFace || !documentId}>
        {saved?.kind === "face" ? "Pick a replacement planar face" : "Pick a planar face"}
      </option>
      {saved && saved.kind !== "face" && !sourceListed && <option value={current} disabled>Orientation datum unavailable</option>}
      {sources.map(({ kind, id, label }) =>
        <option key={sourceKey(kind, id)} value={sourceKey(kind, id)}>{label}</option>)}
    </select>
      {pickingFace && <>
        <p role="status">Click a flat workpiece face in the 3D view.</p>
        <button type="button" onClick={onCancelFace}>Cancel face pick</button>
      </>}
    </dd>
    <dt><label htmlFor="cam-flip-tool">Flip tool direction</label></dt>
    <dd><input id="cam-flip-tool" type="checkbox" checked={flip} onChange={(event) =>
      onChange({ ...(orientation ?? { kind: sketchDefault ? "sketch" : "setup" }), flip: event.target.checked })} /></dd>
  </>;
}
