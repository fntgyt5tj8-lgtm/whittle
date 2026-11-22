import { documentEvaluator, toolForBody, toolForTip } from "@whittle/core";
import type { CamGeometryRef } from "@whittle/cam";
import type { CamCadAdapter } from "./cadAdapter";
import { findFeature, useApp } from "../state/store";

import { edgeRefFromPick, faceRefFromPick } from "../state/actions";
import { modelAnchor, resolveModelEdge, resolveModelFloor } from "./modelReferences";
import { sketchContour } from "./sketchContour";

export const whittleCad: CamCadAdapter = {
  getCoordinateSystems() {
    const { doc } = useApp.getState();
    return doc.features.filter((feature) => feature.type === "csys" && !toolForTip(doc, feature.id));
  },

  resolveToolCutting(id) {
    const { doc, builtDoc, regen } = useApp.getState();
    return builtDoc === doc ? regen?.camToolCutting?.find(({ toolId }) => toolId === id)?.result : undefined;
  },

  resolveCoordinateSystem(id) {
    const { doc, builtDoc, regen } = useApp.getState();
    if (builtDoc !== doc || !findFeature(doc, id, "csys")) return undefined;
    if (regen?.status.find((item) => item.id === id)?.state !== "ok") return undefined;
    const frame = regen?.planes.find((item) => item.id === id && item.kind === "csys");
    return frame && { origin: frame.origin, x: frame.xDir, y: frame.yDir, z: frame.normal };
  },

  getSelection() {
    const { doc, selection } = useApp.getState();
    const documentId = doc.id;
    if (!documentId) return [];

    return selection.flatMap<CamGeometryRef>((pick) => {
      if (pick.kind === "body" && !toolForBody(doc, pick.bodyId)) return [{ documentId, kind: "body", entityId: pick.bodyId }];
      if (pick.kind === "sketch" || pick.kind === "region") {
        return [{ documentId, kind: "sketch", entityId: pick.sketchId }];
      }
      return [];
    });
  },

  resolveSketchFrame(ref) {
    const { doc, builtDoc, regen } = useApp.getState();
    if (ref.kind !== "sketch" || doc.id !== ref.documentId || builtDoc !== doc) return undefined;
    if (regen?.status.find((item) => item.id === ref.entityId)?.state !== "ok") return undefined;
    const frame = regen?.sketches.find((item) => item.id === ref.entityId);
    return frame && { origin: frame.origin, x: frame.xDir, y: frame.yDir, z: frame.normal };
  },

  resolveContour(ref) {
    const { doc, regen } = useApp.getState();
    const sketch = findFeature(doc, ref.entityId, "sketch");
    if (!sketch || !whittleCad.resolveSketchFrame(ref)) {
      return { ok: false, errors: ["The selected sketch is missing, failed to build, or is still updating."] };
    }
    return sketchContour(doc, sketch, regen?.sketches.find((item) => item.id === ref.entityId)?.solution);
  },

  selectedEdges() {
    const { doc, builtDoc, selection, regen } = useApp.getState();
    if (doc !== builtDoc) return [];
    return selection.flatMap((pick) => {
      const edge = edgeRefFromPick(pick);
      const body = edge && regen?.bodies.find((item) => item.id === edge.bodyId);
      return edge && body && !toolForBody(doc, edge.bodyId) ? [{ ...edge, anchor: modelAnchor(body) }] : [];
    });
  },

  selectedFloor() {
    const { doc, builtDoc, selection, regen } = useApp.getState();
    if (doc !== builtDoc) return;
    const faces = selection.flatMap((pick) => {
      const face = faceRefFromPick(pick);
      return face && !toolForBody(doc, face.bodyId) ? [face] : [];
    });
    const face = faces.length === 1 ? faces[0] : undefined;
    const body = face && regen?.bodies.find((item) => item.id === face.bodyId);
    return face?.surface === "PLANE" && body ? { ...face, anchor: modelAnchor(body) } : undefined;
  },

  resolveEdge(ref) {
    const { doc, builtDoc, regen } = useApp.getState();
    if (doc !== builtDoc) return;
    const body = regen?.bodies.find((item) => item.id === ref.bodyId);
    const edge = body && resolveModelEdge(body, ref);
    return edge?.ends && { ...edge, ends: edge.ends };
  },

  resolveFloor(ref) {
    const { doc, builtDoc, regen } = useApp.getState();
    if (doc !== builtDoc) return;
    const body = regen?.bodies.find((item) => item.id === ref.bodyId);
    const face = body && resolveModelFloor(body, ref);
    return face && { ...face, bodyId: ref.bodyId, anchor: ref.anchor };
  },

  resolveToolBodies(ids) {
    const { doc, builtDoc, regen } = useApp.getState();
    return builtDoc === doc && ids.every((id) => {
      const feature = findFeature(doc, id);
      return regen?.bodies.some((body) => body.id === id)
        && feature && regen.status.some((status) => status.id === feature.id && status.state === "ok")
        && whittleCad.resolveGeometry({ documentId: doc.id!, kind: "body", entityId: id });
    });
  },

  resolveCircularProfile(ref) {
    const { doc, regen } = useApp.getState();
    const operationFrame = whittleCad.resolveSketchFrame(ref);
    if (!operationFrame) return undefined;
    const sketch = findFeature(doc, ref.entityId, "sketch");
    const frame = regen?.sketches.find((item) => item.id === ref.entityId);
    if (!sketch || !frame) return undefined;
    const entities = sketch.entities.filter((item) => !item.construction);
    const geometry = (sketch.geometry ?? []).filter((item) => item.type !== "point" && !item.construction);
    if (entities.length + geometry.length !== 1) return undefined;

    const entity = entities[0];
    if (entity?.type === "circle" && entity.mode !== "subtract") {
      const evaluator = documentEvaluator(doc);
      try {
        const center = [evaluator.num(entity.cx, "length"), evaluator.num(entity.cy, "length")] as const;
        return { center, radius: evaluator.num(entity.r, "length"), operationFrame };
      } catch {
        return undefined;
      }
    }

    const circle = geometry[0];
    const solution = frame.solution;
    if (circle?.type === "circle" && (solution?.state === "full" || solution?.state === "under")) {
      const center = solution.points[circle.c];
      const radius = solution.radii[circle.id];
      if (center && radius !== undefined) return { center, radius, operationFrame };
    }
    return undefined;
  },

  resolveGeometry(ref) {
    const { doc, builtDoc, regen } = useApp.getState();
    if (doc.id !== ref.documentId) return undefined;

    if (ref.kind === "sketch") {
      const sketch = findFeature(doc, ref.entityId, "sketch");
      return sketch && { name: sketch.name };
    }

    const body = doc.bodies[ref.entityId];
    if (!body) return undefined;
    if (builtDoc === doc) {
      if (!regen?.bodies.some(({ id }) => id === ref.entityId)) return undefined;
      const failedPlacement = doc.features.some((f) => f.type === "move" && !f.copy && f.bodyId === ref.entityId
        && regen.status.some(({ id, state }) => id === f.id && (state === "error" || state === "incomplete")));
      if (failedPlacement) return undefined;
    }
    return { name: body.name };
  },
};
