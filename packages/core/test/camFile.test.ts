import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createProject } from "@whittle/cam";
import {
  copyLegacyManufacturing, deserializeCamDocument, deserializeDocument, makeImport, makePrimitive,
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
