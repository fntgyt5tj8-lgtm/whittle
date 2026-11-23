import type { CircularProfileGeometry } from "../geometry/circle";
import { isCamFrame, transformCamVector, unit, type CamFrame, type CamVector } from "../geometry/frames";
import type { CamResult, FlatEndmill } from "../model";
import type { CamMotion, CamToolpath } from "../toolpath/model";
import { CAM_LENGTH_TOLERANCE, validateToolpath } from "../toolpath/validation";

export interface CircularProfile {
  readonly geometry: CircularProfileGeometry;
  readonly workpieceCsys: CamFrame;
  readonly tool: FlatEndmill;
  readonly side: "inside" | "outside";
  readonly direction: "cw" | "ccw";
  /** Positive down from the sketch plane. */
  readonly depth: number;
  /** Positive up from the sketch plane. */
  readonly clearance: number;
  readonly feed: number;
  readonly plungeFeed: number;
}

/** Computes a toolpath from numeric geometry and machining parameters. */
export type CircularProfileAlgorithm = (input: CircularProfile) => CamResult<CamToolpath>;

const positive = (value: number) => Number.isFinite(value) && value > 0;

export function validateCircularProfile(input: CircularProfile): string[] {
  const { geometry, workpieceCsys, tool, side, direction, depth, clearance, feed, plungeFeed } = input;
  const errors: string[] = [];
  if (!isCamFrame(workpieceCsys)) errors.push("Workpiece CSYS must be a finite right-handed orthonormal frame.");
  if (!isCamFrame(geometry.operationFrame)) errors.push("Operation frame must be a finite right-handed orthonormal frame.");
  if (!geometry.center.every(Number.isFinite) || !positive(geometry.radius)) errors.push("Circle requires a finite center and positive radius.");
  if (tool.kind !== "flat-endmill" || !positive(tool.diameter)) errors.push("Flat endmill diameter must be positive.");
  if (side !== "inside" && side !== "outside") errors.push("Choose an inside or outside profile.");
  if (direction !== "cw" && direction !== "ccw") errors.push("Choose a clockwise or counterclockwise profile.");
  const radius = geometry.radius + (side === "inside" ? -1 : 1) * tool.diameter / 2;
  if (!Number.isFinite(radius) || radius <= CAM_LENGTH_TOLERANCE) errors.push("Compensated cutter radius must be positive.");
  if (!positive(depth)) errors.push("Cut depth must be positive.");
  if (!positive(clearance)) errors.push("Clearance must be positive.");
  if (!positive(feed)) errors.push("Cut feed must be positive.");
  if (!positive(plungeFeed)) errors.push("Plunge feed must be positive.");
  return errors;
}

/** One depth pass, with axial entry and retract at the compensated start point. */
export const generateCircularProfile: CircularProfileAlgorithm = function generateCircularProfile(input) {
  const errors = validateCircularProfile(input);
  if (errors.length) return { ok: false, errors };

  const { geometry, workpieceCsys, tool, side, direction, depth, clearance, feed, plungeFeed } = input;
  const { center: [x, y], operationFrame } = geometry;
  const radius = geometry.radius + (side === "inside" ? -1 : 1) * tool.diameter / 2;
  const point = (v: CamVector) => transformCamVector(v, operationFrame, workpieceCsys, "point");
  const toolAxis = unit(transformCamVector([0, 0, 1], operationFrame, workpieceCsys, "direction"));
  const safe = point([x + radius, y, clearance]);
  const start = point([x + radius, y, -depth]);
  const ordinate = direction === "ccw" ? radius : -radius;
  const points = [point([x, y + ordinate, -depth]), point([x - radius, y, -depth]), point([x, y - ordinate, -depth]), start];
  const center = point([x, y, -depth]);
  const motions: CamMotion[] = [{ kind: "line", mode: "plunge", start: safe, end: start, toolAxis }];
  let previous = start;
  for (const end of points) {
    motions.push({ kind: "arc", start: previous, end, center, normal: toolAxis, direction, toolAxis });
    previous = end;
  }
  motions.push({ kind: "line", mode: "rapid", start, end: safe, toolAxis });
  const value = { tool, feed, plungeFeed, motions };
  const motionErrors = validateToolpath(value);
  return motionErrors.length ? { ok: false, errors: motionErrors } : { ok: true, value };
};
