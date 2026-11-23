import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAM_WORLD, exportAptProgram, flipCamFrame, generateCircularProfile, transformCamVector, type AptOperation, type CamFrame, type CamVector } from "../src";
import { cross, dot, subtract } from "../src/geometry/frames";

const side: CamFrame = { origin: [10, 20, 30], x: [1, 0, 0], y: [0, 0, -1], z: [0, 1, 0] };
const tilted: CamFrame = { ...side, y: [0, 0.6, -0.8], z: [0, 0.8, 0.6] };
const context: CamFrame = { ...CAM_WORLD, origin: [-3, 11, 2], x: [0, 1, 0], y: [-1, 0, 0] };

function operation(name: string, operationFrame: CamFrame, direction: "cw" | "ccw", toolNumber: number): AptOperation {
  const result = generateCircularProfile({
    geometry: { center: [0, 0], radius: 4, operationFrame },
    workpieceCsys: context, tool: { kind: "flat-endmill", diameter: 2 }, side: "outside", direction,
    depth: 2, clearance: 3, feed: 240, plungeFeed: 60,
  });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return { name, path: result.value, frame: context, toolNumber, spindleRpm: 5000 };
}

const operations = [
  operation("Top", CAM_WORLD, "ccw", 1),
  operation("Vertical", side, "ccw", 1),
  operation("Tilted", tilted, "cw", 2),
  operation("Flipped", flipCamFrame(tilted), "ccw", 2),
];

function exported(items = operations) {
  const result = exportAptProgram("Indexed profiles", items);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.value;
}

const records = (text: string, code: string) => text.split("\n").filter((line) => line.startsWith(code + "/"))
  .map((line) => line.slice(code.length + 1).split(",").map(Number));
function near(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((v, index) => expect(actual[index]).toBeCloseTo(v, 10));
}

describe("indexed APT program", () => {
  it("matches the golden file and emits ordered tool changes and one terminator", () => {
    expect(exported()).toBe(readFileSync(new URL("./fixtures/indexed-profiles.apt", import.meta.url), "utf8"));
    expect(records(exported(), "LOADTL")).toEqual([[1], [2]]);
    expect(exported().match(/^FINI$/gm)).toHaveLength(1);
  });

  it.each(operations.map((op, index) => ({ op, setup: [CAM_WORLD, side, tilted, flipCamFrame(tilted)][index]! })))(
    "preserves endpoint, direction and circle geometry for $op.name",
    ({ op, setup }) => {
      const text = exported([op]);
      const [from] = records(text, "FROM");
      const stops = records(text, "GOTO");
      const circles = records(text, "CIRCLE");
      const expectedStart = transformCamVector([5, 0, 3], setup, CAM_WORLD, "point");
      near(from!, [...expectedStart, ...setup.z]);
      expect(stops).toHaveLength(op.path.motions.length);
      expect(circles).toHaveLength(4);
      let start = from!.slice(0, 3) as unknown as CamVector;
      let circleIndex = 0;
      op.path.motions.forEach((motion, index) => {
        const stop = stops[index]!;
        near(stop, [...transformCamVector(motion.end, context, CAM_WORLD, "point"), ...setup.z]);
        const end = stop.slice(0, 3) as unknown as CamVector;
        if (motion.kind === "arc") {
          const circle = circles[circleIndex++]!;
          const center = circle.slice(0, 3) as unknown as CamVector;
          const normal = circle.slice(3, 6) as unknown as CamVector;
          near(circle, [...transformCamVector([0, 0, -2], setup, CAM_WORLD, "point"),
            ...setup.z.map((v) => motion.direction === "cw" ? -v : v), 5]);
          const a = subtract(start, center), b = subtract(end, center);
          expect(Math.hypot(...a)).toBeCloseTo(5, 10);
          expect(Math.hypot(...b)).toBeCloseTo(5, 10);
          expect(dot(a, normal)).toBeCloseTo(0, 10);
          expect(dot(b, normal)).toBeCloseTo(0, 10);
          expect(dot(cross(a, b), normal)).toBeCloseTo(25, 10);
        }
        start = end;
      });
    },
  );

  it("subdivides major arcs analytically and helical entries into bounded feed chords", () => {
    const start = [5, 0, 0] as const;
    const axis = CAM_WORLD.z;
    const base = { kind: "arc", start, center: CAM_WORLD.origin, normal: axis, direction: "ccw", toolAxis: axis } as const;
    const op = operations[0]!;
    const path = { ...op.path, motions: [
      { ...base, end: [0, -5, 0] },
      { ...base, start: [0, -5, 0], end: [5, 0, -1], helical: true },
    ] } as const;
    const text = exported([{ ...op, frame: CAM_WORLD, path }]);
    expect(records(text, "CIRCLE")).toHaveLength(2);
    const stops = records(text, "GOTO");
    near(stops[1]!, [0, -5, 0, 0, 0, 1]);
    let previous = stops[1]!;
    for (const point of stops.slice(2)) {
      expect(point[2]).toBeLessThan(previous[2]!);
      expect(Math.hypot((point[0]! + previous[0]!) / 2, (point[1]! + previous[1]!) / 2)).toBeGreaterThanOrEqual(4.99);
      previous = point;
    }
    near(previous, [5, 0, -1, 0, 0, 1]);
  });
});
