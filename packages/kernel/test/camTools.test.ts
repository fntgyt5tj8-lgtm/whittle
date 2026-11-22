import { createRequire } from "node:module";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { beforeAll, expect, it } from "vitest";
import { createProject, type CamToolPosition } from "@whittle/cam";
import {
  cadRevision, deserializeCamDocument, makeCsys, makeImport, makeMove, makePrimitive,
  newDocument, removeCamToolGeometry, serializeCamDocument, serializeDocument,
} from "@whittle/core";
import { Builder } from "../src/build";

beforeAll(async () => {
  const wasm = createRequire(import.meta.url).resolve("replicad-opencascadejs/wasm");
  setOC(await (opencascade as any)({ locateFile: () => wasm }));
});

it("round-trips independent tool instances and native TIPs without changing the pinned CAD", async () => {
  const source = newDocument("Source CAD");
  const box = makePrimitive(source, "box");
  source.features.push(box);
  const original = structuredClone(source);
  const sourceBytes = Uint8Array.from(serializeDocument(source));
  const revision = await cadRevision(sourceBytes);
  const doc = newDocument("CAM");
  const component = (name: string) => {
    const feature = makeImport(doc, "source.whittle", "whittle", Buffer.from(sourceBytes).toString("base64"));
    feature.cadSource = { version: 1, documentId: source.id!, bodyId: box.id, revision };
    doc.bodies[feature.id] = { name, color: "#aaaaaa", visible: name !== "Holder" };
    return feature;
  };
  const ordinary = component("Original CAM import");
  const cutter = component("Cutter");
  const holder = component("Holder");
  const spare = component("Spare");
  const move = makeMove(doc, holder.id);
  if (move.type !== "move") throw new Error("Expected a native Move");
  move.translate[0] = "30";
  const tip = { ...makeCsys(doc), name: "TIP" };
  const otherTip = { ...makeCsys(doc), name: "TIP" };
  tip.position[0] = "height";
  doc.parameters.push({ id: "height", name: "height", expr: "2 mm", kind: "length" });
  doc.features.push(ordinary, cutter, holder, tip, move, spare, otherTip);
  const tool: CamToolPosition = {
    id: "tool-a", number: 7, name: "Endmill", tipCsysId: tip.id,
    components: [{ bodyId: cutter.id, role: "cutter" }, { bodyId: holder.id, role: "holder" }],
    cutting: { kind: "flat-endmill", diameter: 6 },
  };
  const other: CamToolPosition = {
    ...tool, id: "tool-b", number: 8, tipCsysId: otherTip.id, components: [{ bodyId: spare.id, role: "insert" }],
  };
  doc.manufacturing = { ...createProject("CAM"), toolPositions: [tool, other] };

  const engine = new Builder();
  await engine.prepareImports(doc);
  const editable = engine.regen(doc, "preview", tip.id);
  const local = editable.planes.find((plane) => plane.id === tip.id)!;
  expect(local.origin).toEqual([2, 0, 0]);
  const lower = (result: ReturnType<Builder["regen"]>, id: string) =>
    result.bodies.find((body) => body.id === id)!.bbox[0];
  const baseline = engine.regen(doc, "final");
  expect(lower(baseline, holder.id)[0] - lower(baseline, cutter.id)[0]).toBeCloseTo(30);

  tip.position = ["100", "height", "0"];
  tip.rotation[2] = "90";
  const rotated = engine.regen(doc, "final");
  const placed = rotated.planes.find((plane) => plane.id === tip.id)!;
  expect(placed.origin).toEqual([100, 2, 0]);
  expect(placed.xDir[1]).toBeCloseTo(1);
  expect(lower(rotated, holder.id)[1] - lower(rotated, cutter.id)[1]).toBeCloseTo(30);
  expect(lower(rotated, holder.id)[0]).toBeCloseTo(lower(rotated, cutter.id)[0]);
  expect(lower(rotated, ordinary.id)).toEqual(lower(rotated, spare.id));
  expect(lower(rotated, ordinary.id)).toEqual(lower(baseline, ordinary.id));

  tip.position[0] = "120";
  const translated = engine.regen(doc, "final");
  for (const id of [cutter.id, holder.id]) {
    expect(lower(translated, id)[0] - lower(rotated, id)[0]).toBeCloseTo(20);
    expect(lower(translated, id)[1]).toBeCloseTo(lower(rotated, id)[1]);
  }
  move.translate[0] = "45";
  const componentMoved = engine.regen(doc, "final");
  expect(lower(componentMoved, cutter.id)).toEqual(lower(translated, cutter.id));
  expect(lower(componentMoved, holder.id)[1] - lower(componentMoved, cutter.id)[1]).toBeCloseTo(45);

  const localCutter = editable.pickBodies!.find((body) => body.id === cutter.id)!;
  const z = localCutter.edges.find((edge) => edge.curve === "LINE" && Math.abs(edge.tangent[2]) > 0.99)!;
  const x = localCutter.edges.find((edge) => edge.curve === "LINE" && Math.abs(edge.tangent[0]) > 0.99)!;
  tip.mode = "references";
  tip.refs = {
    origin: { kind: "vertex", edge: { ...z, bodyId: cutter.id }, end: 0 },
    z: { kind: "edge", edge: { ...z, bodyId: cutter.id } },
    x: { kind: "edge", edge: { ...x, bodyId: cutter.id } },
  };
  const initialReferences = engine.regen(doc, "final");
  expect(initialReferences.status.find(({ id }) => id === tip.id)?.state).toBe("ok");
  tip.flipZ = true;
  const referenced = engine.regen(doc, "final");
  const refFrame = referenced.planes.find(({ id }) => id === tip.id)!;
  const firstFrame = initialReferences.planes.find(({ id }) => id === tip.id)!;
  expect(refFrame.normal[2]).toBeCloseTo(-firstFrame.normal[2]);
  expect(refFrame.origin).toEqual(firstFrame.origin);
  expect(Math.abs(lower(referenced, holder.id)[0] - lower(referenced, cutter.id)[0])).toBeCloseTo(45);
  const cutterMove = makeMove(doc, cutter.id);
  if (cutterMove.type !== "move") throw new Error("Expected a native Move");
  cutterMove.translate[2] = "7";
  doc.features.push(cutterMove);
  const movedReferenceSource = engine.regen(doc, "final");
  expect(movedReferenceSource.planes).toEqual(referenced.planes);
  expect(lower(movedReferenceSource, holder.id)).toEqual(lower(referenced, holder.id));
  const reopened = deserializeCamDocument(serializeCamDocument(doc));
  expect(reopened.manufacturing).toEqual(doc.manufacturing);
  expect(reopened.bodies[holder.id]?.visible).toBe(false);
  const rebuilt = new Builder();
  await rebuilt.prepareImports(reopened);
  const reopenedGeometry = rebuilt.regen(reopened, "final");
  expect(reopenedGeometry.planes).toEqual(referenced.planes);
  expect(reopenedGeometry.bodies.map(({ id, bbox }) => ({ id, bbox })))
    .toEqual(movedReferenceSource.bodies.map(({ id, bbox }) => ({ id, bbox })));

  removeCamToolGeometry(reopened, tool, cutter.id);
  const remaining = { ...tool, components: tool.components.filter((item) => item.bodyId !== cutter.id) };
  reopened.manufacturing = { ...reopened.manufacturing!, toolPositions: [remaining, other] };
  const invalid = rebuilt.regen(deserializeCamDocument(serializeCamDocument(reopened)), "final");
  expect(invalid.planes.some(({ id }) => id === tip.id)).toBe(false);
  expect(invalid.status.find(({ id }) => id === tip.id)?.state).toBe("error");
  expect(invalid.status.find(({ id }) => id === move.id)?.message).toMatch(/Resolve TIP/);

  removeCamToolGeometry(reopened, remaining);
  reopened.manufacturing = { ...reopened.manufacturing!, toolPositions: [other] };
  const deleted = rebuilt.regen(deserializeCamDocument(serializeCamDocument(reopened)), "final");
  expect(deleted.bodies.map(({ id }) => id)).toEqual([ordinary.id, spare.id]);
  expect(deleted.planes.map(({ id }) => id)).toEqual([otherTip.id]);
  expect(source).toEqual(original);
  expect(await cadRevision(sourceBytes)).toBe(revision);
});

it("migrates a legacy tool's evaluated TIP and component poses on reopen", async () => {
  const doc = newDocument("Legacy CAM");
  const source = newDocument("Tool CAD");
  const shape = makePrimitive(source, "box");
  source.features.push(shape);
  const bytes = Uint8Array.from(serializeDocument(source));
  const cutter = makeImport(doc, "legacy.whittle", "whittle", Buffer.from(bytes).toString("base64"));
  cutter.cadSource = { version: 1, documentId: source.id!, bodyId: shape.id, revision: await cadRevision(bytes) };
  const move = makeMove(doc, cutter.id);
  if (move.type !== "move") throw new Error("Expected a native Move");
  move.translate[2] = "9";
  const tip = makeCsys(doc);
  tip.position = ["4", "2", "0"];
  tip.rotation[0] = "20";
  doc.features.push(cutter, move, tip);
  doc.manufacturing = { ...createProject("Legacy CAM"), toolPositions: [{
    id: "legacy", number: 1, name: "Legacy tool", tipCsysId: tip.id,
    components: [{ bodyId: cutter.id, role: "cutter" }],
    placement: { position: ["22", "6", "8"], rotation: ["0", "90", "30"] },
  }] };

  const legacy = deserializeCamDocument(serializeCamDocument(doc));
  const engine = new Builder();
  await engine.prepareImports(legacy);
  const old = engine.regen(legacy, "final");
  const migrated = engine.migrateCamTools(legacy);
  expect(migrated.manufacturing?.toolPositions?.[0]?.placement).toBeUndefined();
  expect(migrated.manufacturing?.toolPositions?.[0]?.components[0]?.sourceToTip).toBeDefined();
  const updated = deserializeCamDocument(serializeCamDocument({
    ...legacy, manufacturing: migrated.manufacturing,
    features: legacy.features.map((feature) => migrated.tips.find(({ id }) => id === feature.id) ?? feature),
  }));
  const current = engine.regen(updated, "final");
  const oldFrame = old.planes[0]!;
  const newFrame = current.planes[0]!;
  for (const key of ["origin", "xDir", "yDir", "normal"] as const) {
    newFrame[key].forEach((value, index) => expect(value).toBeCloseTo(oldFrame[key][index]!, 9));
  }
  current.bodies[0]!.bbox.flat().forEach((value, index) => expect(value).toBeCloseTo(old.bodies[0]!.bbox.flat()[index]!, 8));
  expect(engine.migrateCamTools(updated).tips).toEqual([]);
});
