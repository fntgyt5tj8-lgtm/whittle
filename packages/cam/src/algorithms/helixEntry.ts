import type { CamResult, PocketMillingSettings } from "../model";
import { closestContourPoint, contourPoint, trimContourCurve,
  type ContourCurve, type ContourPoint, type HelixEntry } from "./contour";

const DISTANCE_TOLERANCE = 1e-7;
const TAU = 2 * Math.PI;
const distance = (a: ContourPoint, b: ContourPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const fail = (message: string): CamResult<never> => ({ ok: false, errors: [message] });

type FitEntry = (cut: readonly ContourCurve[], index: number) =>
  CamResult<{ cut: readonly ContourCurve[]; entry: HelixEntry }>;

export function prepareHelicalEntry(
  boundaries: readonly (readonly ContourCurve[])[],
  settings: PocketMillingSettings, cutterDiameter: number,
): CamResult<FitEntry> {
  const diameter = settings.helixDiameter?.trim() ? Number(settings.helixDiameter) : cutterDiameter / 2;
  const rampAngle = settings.rampAngle?.trim() ? Number(settings.rampAngle) : 3;
  if (!Number.isFinite(diameter) || diameter <= DISTANCE_TOLERANCE * 2) {
    return fail("Enter a positive helix diameter or leave it blank to use half the cutter diameter.");
  }
  if (!Number.isFinite(rampAngle) || rampAngle < 1 || rampAngle > 15) {
    return fail("Enter a helix ramp angle from 1° to 15°.");
  }

  const orbit = diameter / 2;
  const footprint = orbit + cutterDiameter / 2;
  const pitch = TAU * orbit * Math.tan(rampAngle * Math.PI / 180);
  const walls = boundaries.flat();

  function fits(center: ContourPoint) {
    return walls.every((wall) => distance(center, closestContourPoint(center, wall)) >= footprint - DISTANCE_TOLERANCE);
  }

  function atSeam(seam: ContourPoint) {
    if (fits(seam)) return { center: seam, start: [seam[0] + orbit, seam[1]] as ContourPoint };
    const nearest = walls.map((wall) => closestContourPoint(seam, wall))
      .sort((a, b) => distance(seam, a) - distance(seam, b)).slice(0, 3);
    for (const point of nearest) {
      const heading = Math.atan2(seam[1] - point[1], seam[0] - point[0]);
      for (const turn of [0, -Math.PI / 4, Math.PI / 4]) {
        const center: ContourPoint = [seam[0] + orbit * Math.cos(heading + turn), seam[1] + orbit * Math.sin(heading + turn)];
        if (fits(center)) return { center, start: seam };
      }
    }
  }

  const fit: FitEntry = (cut, index) => {
    const first = contourPoint(cut[0]!, 0);
    const last = contourPoint(cut.at(-1)!, 1);
    // A closed cut can start on a longer wall if the original seam is at a corner.
    const seamCandidates = distance(first, last) > 1e-5 ? [] : cut.map((curve, i) =>
      ({ i, length: distance(contourPoint(curve, 0), contourPoint(curve, 1)) }))
      .sort((a, b) => b.length - a.length).slice(0, 24);
    let found = atSeam(first);
    let path = cut;
    if (!found) {
      for (const { i } of seamCandidates) {
        const curve = cut[i]!;
        found = atSeam(contourPoint(curve, 0.5));
        if (!found) continue;
        path = [trimContourCurve(curve, 0.5, 1), ...cut.slice(i + 1), ...cut.slice(0, i), trimContourCurve(curve, 0, 0.5)];
        break;
      }
    }
    if (!found) return fail(`A helix does not fit at adaptive cut ${index + 1}. Use a smaller helix diameter or cutter, or select plunge entry.`);
    return { ok: true, value: { cut: path, entry: { ...found, pitch, direction: "ccw" } } };
  };
  return { ok: true, value: fit };
}
