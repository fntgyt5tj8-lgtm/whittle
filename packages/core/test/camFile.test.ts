import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createProject, type CamOrientation } from "@whittle/cam";
import {
  copyLegacyManufacturing, deserializeCamDocument, deserializeDocument, makeCsys, makeImport, makePrimitive,
  newDocument, serializeCamDocument, serializeDocument,
} from "@whittle/core";

describe("independent Manufacturing documents", () => {
  it("keeps geometry, imports, setups and tooling in a CAM container with a distinct format", () => {
    const cad = newDocument("Part");
    const cam = {
      ...newDocument("Manufacturing"),
      manufacturing: { ...createProject("Job"), tooling: { libraryId: "shop" } },
    };
    cam.features.push(makeImport(cam, "stock.obj", "obj", btoa("stock")));
    const cadBytes = serializeDocument(cad);
    const camBytes = serializeCamDocument(cam);
    const members = unzipSync(camBytes);
    expect(Object.keys(members).sort()).toEqual(["geometry.whittle", "manifest.json", "manufacturing.json"]);
    expect(deserializeDocument(members["geometry.whittle"]!).manufacturing).toBeUndefined();
    expect(deserializeCamDocument(camBytes)).toMatchObject({ id: cam.id, manufacturing: cam.manufacturing, features: cam.features });
    expect(() => deserializeCamDocument(cadBytes)).toThrow();
    expect(() => deserializeDocument(camBytes)).toThrow();
    expect(deserializeDocument(cadBytes).manufacturing).toBeUndefined();
    members["manifest.json"] = strToU8(JSON.stringify({ format: "whittle-cam", schema: 2 }));
    expect(() => deserializeCamDocument(zipSync(members))).toThrow(/Unsupported CAM document format/);
  });

  it("round-trips contour seam and combined entry and exit moves", () => {
    const doc = newDocument("Contours");
    doc.manufacturing = {
      ...createProject("Contours"),
      setups: [{ id: "setup", name: "Setup", contexts: [] }],
      processes: [{
        id: "contour", name: "Contour", setupId: "setup", kind: "profile",
        contourMilling: { side: "right", direction: "reverse", depth: "1", clearance: "2",
          leadIn: "1.25", leadOut: "2.75", seam: "0.123456789", aptCutcom: true, millingDirection: "climb", spindleDirection: "ccw",
          stockAllowance: "1.6", radialIncrement: "0.5", finishAllowance: "0.1", optimiseRetracts: true,
          arcLeadIn: "90", arcLeadInRadius: "1.5", normalLeadIn: "1",
          arcLeadOut: "45", arcLeadOutRadius: "2", normalLeadOut: "0.25" },
      }],
    };
    expect(deserializeCamDocument(serializeCamDocument(doc)).manufacturing).toEqual(doc.manufacturing);
  });

  it("round-trips the facing face and raster settings through a CAM file", () => {
    const doc = newDocument("Facing");
    doc.manufacturing = {
      ...createProject("Facing"),
      setups: [{ id: "setup", name: "Setup", contexts: [] }],
      processes: [{
        id: "facing", name: "Facing 1", setupId: "setup", kind: "facing", toolPositionId: "tool",
        orientation: { kind: "csys", documentId: doc.id!, entityId: "datum", flip: true },
        facingFace: { bodyId: "part", center: [0, 0, 2], normal: [0, 0, 1], surface: "PLANE", area: 20 },
        facingMilling: { strategy: "one-way", top: "1", depth: "0", stepdown: ".3", stepover: "80", clearance: "2" },
      }],
    };
    expect(deserializeCamDocument(serializeCamDocument(doc)).manufacturing).toEqual(doc.manufacturing);
  });

  it("migrates a diameter-only tool on open without inventing a sketch or a geometry family", () => {
    const doc = newDocument("Old tool");
    const body = makeImport(doc, "tool.obj", "obj", btoa("geometry"));
    const tip = makeCsys(doc);
    doc.features.push(body, tip);
    const tool = { id: "tool", number: 1, name: "Legacy", tipCsysId: tip.id,
      components: [{ role: "cutter" as const, bodyId: body.id }] };
    doc.manufacturing = { ...createProject("Old tool"), toolPositions: [tool] };
    const members = unzipSync(serializeCamDocument(doc));
    members["manufacturing.json"] = strToU8(JSON.stringify({
      ...doc.manufacturing, toolPositions: [{ ...tool, cutting: { kind: "flat-endmill", diameter: 4.25 },
        components: [{ ...tool.components[0], geometry: { kind: "revolved", sketchId: "old-sketch" } }] }],
    }));
    const opened = deserializeCamDocument(zipSync(members));
    const migrated = opened.manufacturing!.toolPositions![0]!;
    expect(migrated).toEqual({ ...tool, profileDiameter: 4.25 });
    expect(deserializeCamDocument(serializeCamDocument(opened)).manufacturing).toEqual(opened.manufacturing);
  });

  it("round-trips machining orientation sources and flips and rebases local references", () => {
    const doc = newDocument("Oriented operations");
    const sources: (CamOrientation | undefined)[] = [
      undefined, { kind: "setup", flip: true },
      { kind: "face", documentId: doc.id!, flip: true, face: {
        bodyId: "part", center: [2, 3, 4], normal: [0, 0, -1], surface: "PLANE", area: 10,
        anchor: { bounds: [[0, 0, 0], [5, 5, 5]], faceCount: 6, edgeCount: 12 },
      } },
      { kind: "plane", documentId: doc.id!, entityId: "datum" },
      { kind: "csys", documentId: doc.id!, entityId: "csys", flip: true },
    ];
    doc.manufacturing = {
      ...createProject("Oriented operations"),
      setups: [{ id: "setup", name: "Setup", contexts: [] }],
      processes: sources.map((orientation, index) => ({
        id: String(index), name: "Profile", kind: "profile", setupId: "setup", orientation,
      })),
    };
    const reopened = deserializeCamDocument(serializeCamDocument(doc));
    expect(reopened.manufacturing?.processes.map(({ orientation }) => orientation)).toEqual(sources);
    const copy = copyLegacyManufacturing(reopened, "new-cam");
    expect(copy.manufacturing?.processes.map(({ orientation }) => orientation)).toEqual(
      sources.map((source) => source && source.kind !== "setup" ? { ...source, documentId: "new-cam" } : source),
    );
  });

  it("copies a legacy project, rebases local references and preserves the original CAD", () => {
    const legacy = newDocument("Legacy");
    const body = makePrimitive(legacy, "box");
    legacy.features.push(body);
    const part = { documentId: legacy.id!, entityId: body.id, kind: "body" as const };
    const sketch = { documentId: legacy.id!, entityId: "circle", kind: "sketch" as const };
    legacy.manufacturing = {
      ...createProject("Legacy project"),
      setups: [{ id: "setup", name: "Setup", part }],
      processes: [{ id: "profile", name: "Profile", kind: "profile", setupId: "setup", contour: sketch, profile: { csys: "sketch" } }],
    };
    const bytes = serializeDocument(legacy);
    const opened = deserializeDocument(bytes);
    const migrated = copyLegacyManufacturing(opened, "cam-legacy");
    const reopened = deserializeCamDocument(serializeCamDocument(migrated));
    const project = reopened.manufacturing!;
    expect(reopened.id).toBe("cam-legacy");
    expect(reopened.features).toEqual(legacy.features);
    expect(project.setups[0]!.part).toEqual({ ...part, documentId: "cam-legacy" });
    expect(project.setups[0]!.contexts![0]!.bodies[0]!.body).toEqual({ ...part, documentId: "cam-legacy" });
    expect(project.setups[0]!.contexts![0]!.frame).toEqual({ kind: "legacy-sketch", sketch: { ...sketch, documentId: "cam-legacy" } });
    expect(project.processes[0]!.contour).toEqual({ ...sketch, documentId: "cam-legacy" });
    expect(opened.manufacturing!.processes[0]!.contour).toEqual(sketch);
    expect(deserializeDocument(bytes).id).toBe(legacy.id);
  });
});
