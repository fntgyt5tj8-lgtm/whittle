import {
  CAM_WORLD, validateOperationTooling, type CamProcess, type CamProject, type CamResult, type CamWorkpieceContext,
} from "@whittle/cam";
import type { CamCadAdapter } from "./cadAdapter";
import { prepareCircularProfile } from "./circularProfile";
import { prepareMilling } from "./milling";
import { resolveOrientation } from "./orientation";
import type { ToolpathJob } from "./toolpathJob";

// Bump when algorithm or resolved input semantics change.
const toolpathGeneratorVersion = 1;

export function workpieceFrame(cad: CamCadAdapter, workpiece?: CamWorkpieceContext) {
  const frame = workpiece?.frame;
  if (frame?.kind === "native") return cad.resolveCoordinateSystem(frame.csysId);
  if (frame?.kind === "legacy-world") return CAM_WORLD;
  if (frame?.kind === "legacy-sketch" && frame.sketch) return cad.resolveSketchFrame(frame.sketch);
}

export function prepareToolpath(cad: CamCadAdapter, documentId: string | undefined, project: CamProject, item: CamProcess) {
  const setup = project.setups.find(({ id }) => id === item.setupId);
  const context = setup?.contexts?.find(({ id }) => id === item.contextId);
  const frame = workpieceFrame(cad, context);
  const tools = project.toolPositions ?? [];
  const tool = tools.find(({ id }) => id === item.toolPositionId);
  const references = [
    ...validateOperationTooling(item, tools),
    ...(context?.bodies ?? []).flatMap(({ body, role }) =>
      cad.resolveGeometry(body) ? [] : [`The ${role} body (${body.entityId}) is unavailable.`]),
  ];
  const settings = item.facingMilling ?? item.pocketMilling ?? item.contourMilling;
  let prepared: CamResult<ToolpathJob>;
  if (settings) {
    prepared = prepareMilling(cad, documentId, item, settings, tool, frame, references);
  } else {
    const cutting = tool && cad.resolveToolCutting?.(tool.id);
    const tip = tool ? cad.resolveCoordinateSystem(tool.tipCsysId) : CAM_WORLD;
    const input = prepareCircularProfile(item.contour && cad.resolveCircularProfile?.(item.contour), frame,
      cutting?.ok ? cutting.value.diameter : undefined, item.profile,
      (setup, sketch) => item.orientation ? resolveOrientation(cad, documentId, setup, item.orientation, sketch) : undefined,
      () => [
        ...references,
        ...(tool && !tip ? ["Resolve the selected tool's TIP before exporting."] : []),
        ...(tool && (!cutting?.ok || cutting.value.family !== "FLAT")
          ? cutting?.ok ? ["Circular profile export requires a FLAT cutter."]
            : cutting?.errors ?? ["The selected cutting component is unavailable."]
          : []),
      ]);
    const ids = tool?.components.map(({ bodyId }) => bodyId) ?? [];
    prepared = input.ok ? { ok: true, value: { kind: "profile", input: input.value, tip: tip!,
      ids: cad.resolveToolBodies?.(ids) ? ids : [] } } : input;
  }
  // Resolved geometry and frames capture CAD edits even when reference IDs stay the same.
  // Context body roles are validated here. Their solids are not inputs to current strategies.
  const { id, name, track, suppressed, ...operation } = item;
  const key = JSON.stringify([toolpathGeneratorVersion, operation, context?.frame, context?.bodies, tool, prepared],
    (_, value) => typeof value === "number" && !Number.isFinite(value) ? String(value) : value);
  return { key, prepared };
}

export type ToolpathInput = ReturnType<typeof prepareToolpath>;
