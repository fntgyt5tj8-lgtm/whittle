import type { CamToolPosition } from "../../cam/src/model";
import type { Id, WhittleDocument } from "./model";

export function toolForBody(doc: WhittleDocument, bodyId: Id | undefined) {
  return doc.manufacturing?.toolPositions?.find((tool) => tool.components.some((component) => component.bodyId === bodyId));
}

export function toolForTip(doc: WhittleDocument, tipId: Id) {
  return doc.manufacturing?.toolPositions?.find((tool) => tool.tipCsysId === tipId);
}

/** Remove only owned features, leaving source bodies and references in other tools intact. */
export function removeCamToolGeometry(doc: WhittleDocument, tool: CamToolPosition, bodyId?: Id) {
  const removed = new Set(bodyId ? [bodyId] : [tool.tipCsysId, ...tool.components.map((item) => item.bodyId)]);
  const bodies = new Set(bodyId ? [bodyId] : tool.components.map((item) => item.bodyId));
  for (const f of doc.features) {
    if (f.type === "move" && !f.copy && f.bodyId && bodies.has(f.bodyId)) removed.add(f.id);
  }
  if (doc.rollback !== null) {
    doc.rollback -= doc.features.slice(0, doc.rollback).filter((f) => removed.has(f.id)).length;
  }
  doc.features = doc.features.filter((f) => !removed.has(f.id));
  for (const id of removed) {
    delete doc.bodies[id];
    delete doc.datumVisibility?.items?.[id];
  }
  for (const folder of doc.folders ?? []) folder.features = folder.features.filter((id) => !removed.has(id));
}

export function validCamToolGeometry(doc: WhittleDocument): boolean {
  const features = new Map(doc.features.map((f, index) => [f.id, { f, index }]));
  return (doc.manufacturing?.toolPositions ?? []).every((tool) => {
    const tip = features.get(tool.tipCsysId);
    return tip?.f.type === "csys" && tool.components.every(({ bodyId }) => {
      const component = features.get(bodyId);
      return component !== undefined && component.index < tip.index
        && (component.f.type === "import" || (component.f.type === "move" && component.f.copy));
    });
  });
}
