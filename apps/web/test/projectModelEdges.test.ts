import { expect, it } from "vitest";
import { makeSketch, newDocument, resolveGeometry } from "@whittle/core";
import type { EdgeInfo } from "@whittle/kernel";
import { projectModelEdges } from "../src/state/projectModelEdges";

it("projects analytic line and circle data instead of display samples", () => {
  const sketch = makeSketch(newDocument(), { kind: "origin", plane: "XY", offset: "0" });
  if (sketch.type !== "sketch") throw new Error("Expected a sketch.");
  const edges: EdgeInfo[] = [
    { curve: "LINE", ends: [[2, -1, 5], [2, 0, 5]], mid: [2, -0.5, 5], tangent: [0, 1, 0], length: 1 },
    { curve: "CIRCLE", ends: [[2, 0, 5], [0, 2, 5]], mid: [Math.SQRT2, Math.SQRT2, 5],
      tangent: [-Math.SQRT1_2, Math.SQRT1_2, 0], length: Math.PI,
      circle: { center: [0, 0, 5], normal: [0, 0, 1], radius: 2 } },
    { curve: "CIRCLE", ends: [[8, 0, 5], [8, 0, 5]], mid: [4, 0, 5], tangent: [0, -1, 0],
      length: 4 * Math.PI, circle: { center: [6, 0, 5], normal: [0, 0, 1], radius: 2 } },
  ];
  const body = { edges, edgeRanges: new Int32Array(), edgePositions: new Float32Array() };
  expect(projectModelEdges(sketch, body, [0, 1, 2], { origin: [0, 0, 0], xDir: [1, 0, 0], yDir: [0, 1, 0] })).toBe(3);
  expect(resolveGeometry(sketch).filter((g) => g.type !== "point")).toMatchObject([
    { type: "line", a: [2, -1], b: [2, 0] },
    { type: "arc", a: [2, 0], b: [0, 2], c: [0, 0], r: 2, sweep: Math.PI / 2 },
    { type: "circle", c: [6, 0], r: 2 },
  ]);
  const line = sketch.geometry!.find((g) => g.type === "line")!;
  const arc = sketch.geometry!.find((g) => g.type === "arc")!;
  expect(line.b).toBe(arc.a);
  expect(sketch.constraints?.map((c) => c.type)).toEqual(["fixed", "fixed", "fixed"]);
});
