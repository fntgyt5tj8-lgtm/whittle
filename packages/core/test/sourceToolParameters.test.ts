import { expect, it } from "vitest";
import { cuttingToolType } from "@whittle/cam";
import { newDocument, sourceToolParameters } from "@whittle/core";

it("maps the stable numeric cutting families and rejects unassigned codes", () => {
  expect([0, 1, 2, 3, 4, 5].map(cuttingToolType)).toEqual(["FLAT", "BALL", "TOROIDAL", "LOLLIPOP", "CONICAL", "FORM"]);
  for (const value of [-1, 6, 1.5, NaN, Infinity]) expect(cuttingToolType(value)).toBeUndefined();
});

it("evaluates native cutting parameters with source units and expression dependencies", () => {
  const part = newDocument("Microtool");
  part.units = "cm";
  part.parameters = [
    { id: "t", name: "type", expr: "0", kind: "number" },
    { id: "d", name: "CUTTER_DIAMETER", expr: "2 * nose_radius", kind: "length" },
    { id: "r", name: "nose_radius", expr: "0.5 mm", kind: "length" },
    { id: "l", name: "CUTTER_LENGTH", expr: "2", kind: "length" },
    { id: "f", name: "FLUTE_LENGTH", expr: "0.3", kind: "number" },
    { id: "s", name: "CORP_DIAMETER", expr: "6 mm", kind: "length" },
  ];
  expect(sourceToolParameters(part)).toEqual({ ok: true, value: {
    type: 0, family: "FLAT", diameter: 1, cutterLength: 20, fluteLength: 3, shankDiameter: 6,
  } });
  part.parameters[0]!.expr = "0.5";
  part.parameters[0]!.kind = "count";
  expect(sourceToolParameters(part)).toMatchObject({ ok: false, errors: [expect.stringContaining("Unknown cutting part TYPE")] });
  part.parameters.shift();
  expect(sourceToolParameters(part)).toMatchObject({ ok: false, errors: [expect.stringContaining("missing TYPE")] });
});
