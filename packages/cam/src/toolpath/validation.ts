import { dot, isUnit, subtract, type CamVector } from "../geometry/frames";
import type { CamToolpath } from "./model";

export const CAM_LENGTH_TOLERANCE = 1e-7;
const finite = (v: CamVector) => v.every(Number.isFinite);
const distance = (a: CamVector, b: CamVector) => Math.hypot(...subtract(a, b));
const positive = (value: number) => Number.isFinite(value) && value > 0;

export function validateToolpath(path: CamToolpath): string[] {
  const errors: string[] = [];
  if (path.tool.kind !== "flat-endmill" || !positive(path.tool.diameter)) errors.push("Invalid flat endmill.");
  if (!positive(path.feed) || !positive(path.plungeFeed)) errors.push("Invalid feed rates.");
  if (!path.motions.length) errors.push("Toolpath is empty.");

  for (const [index, motion] of path.motions.entries()) {
    const label = `Motion ${index + 1}`;
    const previous = path.motions[index - 1];
    const length = distance(motion.start, motion.end);
    if (!finite(motion.start) || !finite(motion.end) || !Number.isFinite(length) || length <= CAM_LENGTH_TOLERANCE) {
      errors.push(`${label} requires finite, distinct endpoints.`);
    }
    if (!isUnit(motion.toolAxis) || (previous && distance(previous.toolAxis, motion.toolAxis) > 1e-9)) {
      errors.push(`${label} requires a constant unit tool axis.`);
    }
    if (previous && distance(previous.end, motion.start) > CAM_LENGTH_TOLERANCE) {
      errors.push(`${label} is disconnected.`);
    }
    if (motion.kind === "line" && !["rapid", "feed", "plunge"].includes(motion.mode)) {
      errors.push(`${label} has an invalid line mode.`);
    }
    if (motion.kind === "arc") {
      const start = subtract(motion.start, motion.center);
      const end = subtract(motion.end, motion.center);
      const radius = Math.hypot(...start);
      const axial = dot(end, motion.normal);
      const radialEnd = end.map((v, i) => v - axial * motion.normal[i]!);
      const endRadius = Math.hypot(...radialEnd);
      const planarChord = Math.hypot(...radialEnd.map((v, i) => v - start[i]!));
      if (!finite(motion.center) || !isUnit(motion.normal) ||
          !Number.isFinite(radius) || !Number.isFinite(endRadius) || radius <= CAM_LENGTH_TOLERANCE ||
          Math.abs(radius - endRadius) > CAM_LENGTH_TOLERANCE ||
          Math.abs(dot(start, motion.normal)) > CAM_LENGTH_TOLERANCE ||
          (motion.helical === true
            ? Math.abs(axial) <= CAM_LENGTH_TOLERANCE || planarChord <= CAM_LENGTH_TOLERANCE
              || Math.abs(dot(motion.normal, motion.toolAxis)) < 1 - 1e-9
            : motion.helical !== undefined || Math.abs(axial) > CAM_LENGTH_TOLERANCE) ||
          (motion.direction !== "cw" && motion.direction !== "ccw")) {
        errors.push(`${label} has invalid arc geometry.`);
      }
    }
  }
  return errors;
}
