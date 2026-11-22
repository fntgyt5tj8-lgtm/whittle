import { areaPaths, difference, EndType, FillRule, inflatePaths, JoinType, rectClip, union,
  type Path64, type Paths64, type Point64 } from "clipper2-ts";
import type { CamResult } from "../model";
import { contourPoint, type ContourCurve, type ContourPoint } from "./contour";
import { POCKET_INTEGER_SCALE as SCALE } from "./pocketRegions";

const DISK_SIDES = 48;
const MAX_SAMPLES = 75_000;
const MAX_ADVANCE = 6;

interface OffsetLoop {
  curves: ContourCurve[];
  points: Path64;
  swept: Paths64;
}

export function planAdaptiveRegions(
  input: ContourCurve[][][], toolRadius: number, targetWidth: number, targetArea: number,
): CamResult<{ cuts: ContourCurve[][]; transitions: number }> {
  const origin = contourPoint(input[0]![0]![0]!, 0);
  const integer = ([x, y]: ContourPoint): Point64 =>
    ({ x: Math.round((x - origin[0]) * SCALE), y: Math.round((y - origin[1]) * SCALE) });
  const radius = toolRadius * SCALE;
  if (radius < 10 || targetWidth * SCALE < 4) {
    return { ok: false, errors: ["The cutter or engagement is below the adaptive offset tolerance."] };
  }
  const roundTolerance = Math.max(1, radius / 1000);
  // An inscribed polygon models the cutter. The swept mask uses the same radius
  // with a small inward allowance for integer rounding.
  const disk = Array.from({ length: DISK_SIDES }, (_, i) => {
    const angle = i * 2 * Math.PI / DISK_SIDES;
    return { x: Math.round(radius * Math.cos(angle)), y: Math.round(radius * Math.sin(angle)) };
  });
  const limit = targetArea * radius ** 2;
  const interval = Math.max(1, SCALE * Math.min(toolRadius / 2, targetWidth));
  const extent = Math.ceil(radius);
  const negligible = Math.max(1, radius ** 2 / 10_000);

  const levels: OffsetLoop[][] = input.map((level) => level.map((curves) => {
    const points = curves.map((curve) => integer(contourPoint(curve, 0)));
    const swept = inflatePaths([[...points, points[0]!]], Math.max(1, Math.floor(radius) - 1),
      JoinType.Round, EndType.Round, 2, roundTolerance);
    return { curves, points, swept };
  }));
  let cleared: Paths64 = [];
  let remainingSamples = MAX_SAMPLES;
  let transitions = 0;
  const cuts: ContourCurve[][] = [];

  function withinTarget(loop: OffsetLoop, material: Paths64) {
    if (!material.length) return false;
    for (const [i, a] of loop.points.entries()) {
      const b = loop.points[(i + 1) % loop.points.length]!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const samples = Math.max(1, Math.ceil(Math.hypot(dx, dy) / interval));
      for (let j = 0; j < samples; j++) {
        if (remainingSamples-- <= 0) return false;
        const x = Math.round(a.x + dx * j / samples);
        const y = Math.round(a.y + dy * j / samples);
        const localClear = rectClip({ left: x - extent, top: y - extent, right: x + extent, bottom: y + extent }, material);
        const cutter = disk.map((p) => ({ x: x + p.x, y: y + p.y }));
        if (areaPaths(difference([cutter], localClear, FillRule.NonZero)) > limit) return false;
      }
    }
    return true;
  }

  function evaluate(level: OffsetLoop[], allowTransitions: boolean) {
    let swept = cleared;
    let seeds = 0;
    for (const loop of level) {
      if (!withinTarget(loop, swept)) {
        if (!allowTransitions) return undefined;
        seeds++;
      }
      swept = union([...swept, ...loop.swept], FillRule.NonZero);
    }
    return { swept, seeds };
  }

  for (let next = 0; next < levels.length;) {
    let selected = next;
    let result: ReturnType<typeof evaluate>;
    if (next > 0) {
      for (let i = Math.min(next + MAX_ADVANCE - 1, levels.length - 1); i > next; i--) {
        const candidate = evaluate(levels[i]!, false);
        if (!candidate) continue;
        // Skipped loops may run through corners and lobes that the next
        // perimeter misses. Keep them unless their footprint has been swept.
        const covered = levels.slice(next, i).every((level) => level.every((loop) =>
          areaPaths(difference(loop.swept, candidate.swept, FillRule.NonZero)) <= negligible));
        if (!covered) continue;
        selected = i;
        result = candidate;
        break;
      }
    }
    result ??= evaluate(levels[selected]!, true)!;
    if (remainingSamples < 0) return { ok: false, errors: ["Adaptive clearing exceeded its sampling limit. Increase engagement or use a larger cutter."] };
    cleared = result.swept;
    transitions += result.seeds;
    cuts.push(...levels[selected]!.map((loop) => loop.curves));
    next = selected + 1;
  }

  return { ok: true, value: { cuts, transitions } };
}
