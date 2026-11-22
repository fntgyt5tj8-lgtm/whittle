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
  doc.features.push(ordinary, cutter, holder, move, tip, spare, otherTip);
  const tool: CamToolPosition = {
    id: "tool-a", number: 7, name: "Endmill", tipCsysId: tip.id,
    components: [{ bodyId: cutter.id, role: "cutter" }, { bodyId: holder.id, role: "holder" }],
    cutting: { kind: "flat-endmill", diameter: 6 },
    placement: { position: ["100", "0", "0"], rotation: ["0", "0", "90"] },
  };
  const other: CamToolPosition = {
    ...tool, id: "tool-b", number: 8, tipCsysId: otherTip.id, components: [{ bodyId: spare.id, role: "insert" }],
    placement: { position: ["0", "0", "0"], rotation: ["0", "0", "0"] },
  };
  doc.manufacturing = { ...createProject("CAM"), toolPositions: [tool, other] };

  const engine = new Builder();
  await engine.prepareImports(doc);
  const editable = engine.regen(doc, "preview", tip.id);
  const local = editable.planes.find((plane) => plane.id === tip.id)!;
  expect(local.origin).toEqual([2, 0, 0]);
  const baseline = engine.regen(doc, "final");
  const placed = baseline.planes.find((plane) => plane.id === tip.id)!;
  expect(placed.origin).toEqual([100, 2, 0]);
  expect(placed.xDir[1]).toBeCloseTo(1);
  const lower = (id: string) => baseline.bodies.find((body) => body.id === id)!.bbox[0];
  expect(lower(holder.id)[1] - lower(cutter.id)[1]).toBeCloseTo(30);
  expect(lower(ordinary.id)).toEqual(lower(spare.id));

  const localCutter = editable.pickBodies!.find((body) => body.id === cutter.id)!;
  const z = localCutter.edges.find((edge) => edge.curve === "LINE" && Math.abs(edge.tangent[2]) > 0.99)!;
  const x = localCutter.edges.find((edge) => edge.curve === "LINE" && Math.abs(edge.tangent[0]) > 0.99)!;
  tip.mode = "references";
  tip.refs = {
    origin: { kind: "vertex", edge: { ...z, bodyId: cutter.id }, end: 0 },
    z: { kind: "edge", edge: { ...z, bodyId: cutter.id } },
    x: { kind: "edge", edge: { ...x, bodyId: cutter.id } },
  };
  const referenced = engine.regen(doc, "final");
  expect(referenced.status.find(({ id }) => id === tip.id)?.state).toBe("ok");
  const reopened = deserializeCamDocument(serializeCamDocument(doc));
  expect(reopened.manufacturing).toEqual(doc.manufacturing);
  expect(reopened.bodies[holder.id]?.visible).toBe(false);
  const rebuilt = new Builder();
  await rebuilt.prepareImports(reopened);
  const reopenedGeometry = rebuilt.regen(reopened, "final");
  expect(reopenedGeometry.planes).toEqual(referenced.planes);
  expect(reopenedGeometry.bodies.map(({ id, bbox }) => ({ id, bbox })))
    .toEqual(referenced.bodies.map(({ id, bbox }) => ({ id, bbox })));

  removeCamToolGeometry(reopened, tool, cutter.id);
  const remaining = { ...tool, components: tool.components.filter((item) => item.bodyId !== cutter.id) };
  reopened.manufacturing = { ...reopened.manufacturing!, toolPositions: [remaining, other] };
  const invalid = rebuilt.regen(deserializeCamDocument(serializeCamDocument(reopened)), "final");
  expect(invalid.planes.some(({ id }) => id === tip.id)).toBe(false);
  expect(invalid.status.find(({ id }) => id === tip.id)?.state).toBe("error");
  expect(invalid.bodies.find(({ id }) => id === holder.id)?.bbox)
    .toEqual(referenced.bodies.find(({ id }) => id === holder.id)?.bbox);

  removeCamToolGeometry(reopened, remaining);
  reopened.manufacturing = { ...reopened.manufacturing!, toolPositions: [other] };
  const deleted = rebuilt.regen(deserializeCamDocument(serializeCamDocument(reopened)), "final");
  expect(deleted.bodies.map(({ id }) => id)).toEqual([ordinary.id, spare.id]);
  expect(deleted.planes.map(({ id }) => id)).toEqual([otherTip.id]);
  expect(source).toEqual(original);
  expect(await cadRevision(sourceBytes)).toBe(revision);
});
