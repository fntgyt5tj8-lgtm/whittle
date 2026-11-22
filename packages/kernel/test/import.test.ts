/** Round-trip: export a part, import the file back as a body. */
import { createRequire } from "node:module";
import { beforeAll, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type ImportFeature, type PrimitiveFeature, cadRevision, deserializeCamDocument, makeCsys, makeImport, makeMove, makePrimitive, newDocument, serializeCamDocument, serializeDocument } from "@whittle/core";
import { createProject } from "@whittle/cam";
import { Builder } from "../src/build";
import { exportShapes } from "../src/exporters";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

for (const format of ["step", "stl", "obj"] as const) {
  it(`imports a ${format.toUpperCase()} file and scales it`, async () => {
    const src = newDocument();
    const box = makePrimitive(src, "box") as PrimitiveFeature;
    src.features.push(box);
    src.bodies[box.id] = { name: "Box", color: "#ccc", visible: true };
    const b = new Builder();
    const file = await exportShapes(src, b.shapes(src), format);

    const doc = newDocument();
    const im = makeImport(doc, `box.${format}`, format, b64(file.data)) as ImportFeature;
    im.scale = "2";
    doc.features.push(im);
    doc.bodies[im.id] = { name: "Imported", color: "#ccc", visible: true };
    const kb = new Builder();
    await kb.prepareImports(doc);
    const r = kb.regen(doc, "final");
    expect(r.status[0]!.state).toBe("ok");
    expect(r.bodies[0]!.volume).toBeCloseTo(40 * 30 * 20 * 8, -2);
  });
}

it("keeps fractional import scales (25.4 for inches, 0.5 to halve) instead of rounding them", async () => {
  const src = newDocument();
  const box = makePrimitive(src, "box") as PrimitiveFeature;
  src.features.push(box);
  src.bodies[box.id] = { name: "Box", color: "#ccc", visible: true };
  const file = await exportShapes(src, new Builder().shapes(src), "step");
  for (const [scale, k] of [["0.5", 0.5], ["1.5", 1.5], ["25.4", 25.4]] as const) {
    const doc = newDocument();
    const im = makeImport(doc, "box.step", "step", b64(file.data)) as ImportFeature;
    im.scale = scale;
    doc.features.push(im);
    doc.bodies[im.id] = { name: "Imported", color: "#ccc", visible: true };
    const kb = new Builder();
    await kb.prepareImports(doc);
    const r = kb.regen(doc, "final");
    expect(r.status[0]!.state).toBe("ok");
    expect(r.bodies[0]!.volume / (40 * 30 * 20)).toBeCloseTo(k ** 3, 1);
  }
});

it("pins individual CAD bodies and rebuilds CAM-owned placements after reopening", async () => {
  const cad = newDocument("Source");
  const box = makePrimitive(cad, "box");
  const cylinder = makePrimitive(cad, "cylinder");
  cad.features.push(box, cylinder);
  const bytes = new Uint8Array(serializeDocument(cad));
  const revision = await cadRevision(bytes);
  const cam = newDocument("Job");
  cam.manufacturing = createProject("Job");
  const imports = [box, cylinder].map((body) => ({
    ...makeImport(cam, "source.whittle", "whittle", b64(bytes)),
    cadSource: { version: 1 as const, documentId: cad.id!, bodyId: body.id, revision },
  }));
  const from = makeCsys(cam);
  from.position = ["2", "3", "0"];
  from.rotation = ["0", "0", "90"];
  const to = makeCsys(cam);
  to.position = ["100", "50", "14"];
  to.rotation = ["0", "0", "180"];
  const placed = makeMove(cam, imports[0]!.id);
  if (placed.type !== "move") throw new Error("Expected a Move");
  placed.placement = { from: from.id, to: to.id };
  placed.copy = true;
  const manuallyMoved = makeMove(cam, imports[1]!.id);
  if (manuallyMoved.type !== "move") throw new Error("Expected a Move");
  manuallyMoved.translate = ["220", "0", "0"];
  cam.features.push(...imports, from, to, placed, manuallyMoved);
  const reopened = deserializeCamDocument(serializeCamDocument(cam));
  const builder = new Builder();
  await builder.prepareImports(reopened);
  const result = builder.regen(reopened, "final");
  expect(result.status.every(({ state }) => state === "ok")).toBe(true);
  expect(result.bodies.map(({ id }) => id)).toEqual([imports[0]!.id, imports[1]!.id, placed.id]);
  const original = result.bodies[0]!;
  const copy = result.bodies[2]!;
  expect(copy.volume).toBeCloseTo(original.volume, 7);
  expect(result.bodies[1]!.bbox[0][0]).toBeGreaterThan(190);
  const [lo, hi] = original.bbox;
  expect(copy.bbox[0][0]).toBeCloseTo(103 - hi[1]);
  expect(copy.bbox[1][1]).toBeCloseTo(48 + hi[0]);
  expect(copy.bbox[1][2]).toBeCloseTo(14 + hi[2]);
  expect(copy.bbox[0][2]).toBeCloseTo(14 + lo[2]);

  const broken = structuredClone(reopened);
  const first = broken.features[0] as ImportFeature;
  first.cadSource = { ...first.cadSource!, revision: "0".repeat(64) };
  const second = broken.features[1] as ImportFeature;
  second.data = "";
  await builder.prepareImports(broken);
  expect(builder.regen(broken, "final").status).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: first.id, state: "error", message: expect.stringMatching(/revision has changed/) }),
    expect.objectContaining({ id: second.id, state: "error", message: expect.stringMatching(/source is missing/) }),
  ]));
});
