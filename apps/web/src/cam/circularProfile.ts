import { generateCircularProfile, transformCamVector, type CamFrame, type CamResult, type CircularProfileGeometry, type CircularProfileSettings } from "@whittle/cam";
import { machiningPlane } from "./orientation";

export function buildCircularProfile(
  geometry: CircularProfileGeometry | undefined,
  frame: CamFrame | undefined,
  toolDiameter: number | undefined,
  settings: CircularProfileSettings | undefined,
  resolveOrientation: (frame: CamFrame, sketch: CamFrame) => CamResult<CamFrame> | undefined,
  validateReferences: () => readonly string[],
) {
  if (!geometry) return { ok: false, errors: ["The profile sketch is unavailable."] } as const;
  if (!frame) return { ok: false, errors: ["The context coordinate system is unavailable."] } as const;
  const errors = validateReferences();
  if (errors.length) return { ok: false, errors } as const;

  const orientation = resolveOrientation(frame, geometry.operationFrame);
  if (orientation && !orientation.ok) return orientation;
  if (orientation?.ok) {
    const from = geometry.operationFrame;
    const local = machiningPlane(orientation.value, from.origin, from);
    if (!local.ok) return local;
    const [x, y] = transformCamVector([...geometry.center, 0], from, local.value, "point");
    geometry = { ...geometry, center: [x, y], operationFrame: local.value };
  }

  return generateCircularProfile({
    geometry, workpieceCsys: frame, tool: { kind: "flat-endmill", diameter: toolDiameter ?? Number(settings?.diameter) },
    side: settings?.side ?? "outside", direction: settings?.direction ?? "ccw",
    depth: Number(settings?.depth), clearance: Number(settings?.clearance),
    feed: Number(settings?.feed), plungeFeed: Number(settings?.plungeFeed),
  });
}
