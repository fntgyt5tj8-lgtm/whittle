import { documentEvaluator } from "@whittle/core";
import type { CamGeometryRef } from "@whittle/cam";
import type { CamCadAdapter } from "./cadAdapter";
import { findFeature, useApp } from "../state/store";

export const whittleCad: CamCadAdapter = {
  getSelection() {
    const { doc, selection } = useApp.getState();
    const documentId = doc.id;
    if (!documentId) return [];

    return selection.flatMap<CamGeometryRef>((pick) => {
      if (pick.kind === "body") return [{ documentId, kind: "body", entityId: pick.bodyId }];
      if (pick.kind === "sketch") return [{ documentId, kind: "sketch", entityId: pick.sketchId }];
      return [];
    });
  },

  resolveCircularProfile(ref) {
    const { doc, builtDoc, regen } = useApp.getState();
    if (ref.kind !== "sketch" || doc.id !== ref.documentId || builtDoc !== doc) return undefined;
    const sketch = findFeature(doc, ref.entityId, "sketch");
    const frame = regen?.sketches.find((item) => item.id === ref.entityId);
    const status = regen?.status.find((item) => item.id === ref.entityId);
    if (!sketch || !frame || status?.state !== "ok") return undefined;

    const operationFrame = { origin: frame.origin, x: frame.xDir, y: frame.yDir, z: frame.normal };
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
    const { doc, regen, builtDoc } = useApp.getState();
    if (doc.id !== ref.documentId) return undefined;

    if (ref.kind === "sketch") {
      const sketch = findFeature(doc, ref.entityId, "sketch");
      return sketch && { name: sketch.name };
    }

    const body = doc.bodies[ref.entityId];
    if (builtDoc !== doc || !body || !regen?.bodies.some((candidate) => candidate.id === ref.entityId)) {
      return undefined;
    }
    return { name: body.name };
  },
};
