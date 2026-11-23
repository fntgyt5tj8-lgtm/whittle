import { CAM_WORLD, cross, dot, isCamFrame, subtract, transformCamVector, unit, type CamFrame, type CamVector } from "../geometry/frames";
import { validateToolpath } from "../toolpath/validation";
import type { CamResult } from "../model";
import type { CamToolpath } from "../toolpath/model";

export interface AptOperation {
  readonly name: string;
  readonly path: CamToolpath;
  readonly frame: CamFrame;
  readonly toolNumber?: number;
  readonly spindleRpm?: number;
}

function fields(...values: number[]) {
  return values.map((value) => String(Number(value.toPrecision(15)))).join(",");
}

const failure = (errors: string[]): CamResult<string> => ({ ok: false, errors });
const comment = (value: string) => value.replace(/[^\x20-\x7e]/g, " ");

function writeMotions(lines: string[], path: CamToolpath, frame: CamFrame, linearizeHelices: boolean): string[] {
  const errors = validateToolpath(path);
  if (errors.length) return errors;
  const point = (v: CamVector) => transformCamVector(v, frame, CAM_WORLD, "point");
  const direction = (v: CamVector) => unit(transformCamVector(v, frame, CAM_WORLD, "direction"));
  const first = path.motions[0]!;
  const axis = direction(first.toolAxis);
  lines.push(`FROM/${fields(...point(first.start), ...axis)}`);
  const goto = (end: CamVector) => lines.push(`GOTO/${fields(...point(end), ...axis)}`);

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
      if (motion.helical && !linearizeHelices) return [`APT-CL export does not support helical motion ${index + 1}.`];
      const normal: CamVector = motion.direction === "ccw" ? motion.normal
        : [-motion.normal[0], -motion.normal[1], -motion.normal[2]];
      const start = subtract(motion.start, motion.center);
      const end = subtract(motion.end, motion.center);
      const tangent = cross(normal, start);
      const angle = Math.atan2(dot(tangent, end), dot(start, end));
      const sweep = angle > 0 ? angle : angle + 2 * Math.PI;
      const radius = Math.hypot(...start);
      const axial = motion.helical ? dot(end, normal) : 0;
      // The provisional CIRCLE dialect uses directed minor arcs. For helices,
      // constrain the radial chord error to 0.01 mm and preserve axial progress.
      const maxAngle = motion.helical
        ? Math.min(Math.PI / 2, 4 * Math.asin(Math.sqrt(Math.min(1, 0.01 / (2 * radius)))))
        : Math.PI * 0.75;
      const count = Math.ceil(sweep / maxAngle);
      if (count > 100_000) return [`Motion ${index + 1} exceeds the APT-CL arc subdivision limit.`];
      const circle = `CIRCLE/${fields(...point(motion.center), ...direction(normal), radius)}`;
      for (let i = 1; i <= count; i++) {
        const t = i / count;
        const a = sweep * t;
        const intermediate = (j: 0 | 1 | 2) => motion.center[j] + start[j] * Math.cos(a) + tangent[j] * Math.sin(a) + normal[j] * axial * t;
        if (!motion.helical) lines.push(circle);
        goto(i === count ? motion.end : [intermediate(0), intermediate(1), intermediate(2)]);
      }
    } else {
      goto(motion.end);
    }
  }
  return [];
}

/** Legacy single-path output in the supplied path coordinates. */
export function exportAptCl(path: CamToolpath): CamResult<string> {
  const lines = ["UNITS/MM", "MULTAX/ON", `CUTTER/${fields(path.tool.diameter)}`];
  const errors = writeMotions(lines, path, CAM_WORLD, false);
  return errors.length ? failure(errors) : { ok: true, value: [...lines, "FINI", ""].join("\n") };
}

/** Ordered metric CL in the common CAD world frame. Each FROM begins an independent operation. */
export function exportAptProgram(name: string, operations: readonly AptOperation[]): CamResult<string> {
  if (!operations.length) return failure(["The program has no milling operations."]);
  const lines = [`PARTNO/${comment(name)}`, "UNITS/MM", "MULTAX/ON", "$$ FRAME CAD WORLD"];
  let activeTool: number | undefined;
  for (const { name, path, frame, toolNumber, spindleRpm } of operations) {
    if (!isCamFrame(frame)) return failure([`${name}: Invalid toolpath frame.`]);
    if (toolNumber !== undefined && (!Number.isSafeInteger(toolNumber) || toolNumber < 1)) {
      return failure([`${name}: Invalid tool number.`]);
    }
    if (spindleRpm !== undefined && (!Number.isFinite(spindleRpm) || spindleRpm <= 0)) {
      return failure([`${name}: Invalid spindle speed.`]);
    }
    lines.push(`$$ OPERATION ${comment(name)}`);
    if (toolNumber !== undefined && toolNumber !== activeTool) lines.push(`LOADTL/${toolNumber}`);
    activeTool = toolNumber;
    lines.push(`CUTTER/${fields(path.tool.diameter)}`);
    if (spindleRpm !== undefined) lines.push(`$$ SPINDLE RPM ${fields(spindleRpm)}`);
    const errors = writeMotions(lines, path, frame, true);
    if (errors.length) return failure(errors.map((error) => `${name}: ${error}`));
  }
  return { ok: true, value: [...lines, "FINI", ""].join("\n") };
}
