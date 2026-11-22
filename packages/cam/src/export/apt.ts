import { cross, dot, subtract, type CamVector } from "../geometry/frames";
import { validateToolpath } from "../toolpath/validation";
import type { CamResult } from "../model";
import type { CamToolpath } from "../toolpath/model";

function fields(...values: number[]) {
  return values.map((value) => String(Object.is(value, -0) ? 0 : value)).join(",");
}

/**
 * Metric APT-style CL. A directed CIRCLE followed by its endpoint GOTO represents a minor arc.
 * Long arcs must be split by the producer. XYZ and IJK are always in the workpiece CSYS.
 */
export function exportAptCl(path: CamToolpath): CamResult<string> {
  const errors = validateToolpath(path);
  if (errors.length) return { ok: false, errors };
  const first = path.motions[0]!;
  const lines = ["UNITS/MM", "MULTAX/ON", `CUTTER/${fields(path.tool.diameter)}`,
    `FROM/${fields(...first.start, ...first.toolAxis)}`];

  let feed: number | undefined;
  for (const [index, motion] of path.motions.entries()) {
    if (motion.kind === "line" && motion.mode === "rapid") {
      lines.push("RAPID");
      feed = undefined;
    } else {
      const nextFeed = motion.kind === "line" && motion.mode === "plunge" ? path.plungeFeed : path.feed;
      if (feed !== nextFeed) lines.push(`FEDRAT/${fields(nextFeed)},MMPM`);
      feed = nextFeed;
    }
    if (motion.kind === "arc") {
      const normal: CamVector = motion.direction === "ccw" ? motion.normal
        : [-motion.normal[0], -motion.normal[1], -motion.normal[2]];
      const start = subtract(motion.start, motion.center);
      const end = subtract(motion.end, motion.center);
      if (!(dot(cross(start, end), normal) > 0)) {
        return { ok: false, errors: [`Split motion ${index + 1} into arcs shorter than 180 degrees for APT-CL.`] };
      }
      lines.push(`CIRCLE/${fields(...motion.center, ...normal, Math.hypot(...start))}`);
    }
    lines.push(`GOTO/${fields(...motion.end, ...motion.toolAxis)}`);
  }
  return { ok: true, value: [...lines, "FINI", ""].join("\n") };
}
