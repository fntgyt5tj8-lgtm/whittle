import { validCamToolGeometry } from "./camTools";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { migrateWorkpieceContexts } from "../../cam/src/operations";
import { isCamProject } from "../../cam/src/validation";
import { uid } from "./factory";
import { deserializeDocument, FileFormatError, serializeDocument } from "./file";
import { bodyIdsBefore } from "./refs";
import type { CamCadSource } from "../../cam/src/model";
import type { WhittleDocument } from "./model";

export const CAM_EXTENSION = ".cam";
export const CAM_MIME = "application/vnd.whittle.cam+zip";

const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
const MAX_GEOMETRY_BYTES = 512 * 1024 * 1024;

export function serializeCamDocument(doc: WhittleDocument): Uint8Array {
  const { manufacturing, ...geometry } = doc;
  if (!manufacturing || !isCamProject(manufacturing)) throw new FileFormatError("The CAM project is missing or invalid.");
  if (!validCamToolGeometry(doc)) throw new FileFormatError("A tool position has damaged component or TIP ownership.");
  const projectBytes = strToU8(JSON.stringify(manufacturing));
  const geometryBytes = serializeDocument(geometry);
  if (projectBytes.length > MAX_PROJECT_BYTES || geometryBytes.length > MAX_GEOMETRY_BYTES) {
    throw new FileFormatError("The CAM document is too large to save.");
  }
  return zipSync({
    "manifest.json": strToU8(JSON.stringify({ format: "whittle-cam", schema: 1 })),
    "manufacturing.json": projectBytes,
    "geometry.whittle": [geometryBytes, { level: 0 }],
  }, { level: 6 });
}

export function deserializeCamDocument(bytes: Uint8Array): WhittleDocument {
  try {
    const files = unzipSync(bytes, {
      filter: ({ name, originalSize }) =>
        (name === "manifest.json" && originalSize <= 4096) ||
        (name === "manufacturing.json" && originalSize <= MAX_PROJECT_BYTES) ||
        (name === "geometry.whittle" && originalSize <= MAX_GEOMETRY_BYTES),
    });
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
    if (manifest?.format !== "whittle-cam" || manifest.schema !== 1) {
      throw new FileFormatError("Unsupported CAM document format.");
    }
    const project: unknown = JSON.parse(strFromU8(files["manufacturing.json"]!));
    if (!isCamProject(project)) throw new FileFormatError("The CAM project is damaged or uses an unsupported version.");
    const geometry = deserializeDocument(files["geometry.whittle"]!);
    if (geometry.manufacturing) throw new FileFormatError("The CAM geometry contains embedded manufacturing data.");
    const doc = { ...geometry, manufacturing: migrateWorkpieceContexts(project) };
    if (!validCamToolGeometry(doc)) throw new FileFormatError("A tool position has damaged component or TIP ownership.");
    return doc;
  } catch (e) {
    if (e instanceof FileFormatError) throw e;
    throw new FileFormatError("This CAM document is damaged or incomplete.");
  }
}

/** Copy the timeline and all planning data. Intra-document references follow the new identity. */
export function copyLegacyManufacturing(source: WhittleDocument, documentId = uid("cam")): WhittleDocument {
  if (!source.manufacturing) throw new FileFormatError("This design has no embedded Manufacturing project.");
  const doc = structuredClone(source);
  const project = migrateWorkpieceContexts(doc.manufacturing!);
  const rebase = <T extends { readonly documentId: string }>(ref: T): T =>
    ref.documentId === source.id ? { ...ref, documentId } : ref;
  doc.id = documentId;
  doc.manufacturing = {
    ...project,
    setups: project.setups.map((setup) => ({
      ...setup,
      part: setup.part && rebase(setup.part),
      contexts: setup.contexts?.map((context) => ({
        ...context,
        frame: context.frame.kind === "legacy-sketch" && context.frame.sketch
          ? { ...context.frame, sketch: rebase(context.frame.sketch) } : context.frame,
        bodies: context.bodies.map((assignment) => ({ ...assignment, body: rebase(assignment.body) })),
      })),
    })),
    processes: project.processes.map((process) => ({ ...process, contour: process.contour && rebase(process.contour) })),
  };
  return doc;
}

export async function cadRevision(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new FileFormatError("CAD source revisions require HTTPS or localhost.");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateCadSource(ref: CamCadSource, doc: WhittleDocument, revision: string) {
  if (ref.version !== 1) throw new FileFormatError("This CAD reference uses an unsupported version.");
  if (ref.documentId !== doc.id) throw new FileFormatError("The CAD source document identity doesn't match.");
  if (!bodyIdsBefore(doc).includes(ref.bodyId)) throw new FileFormatError("The CAD source body is missing.");
  if (ref.revision !== revision) throw new FileFormatError("The CAD source revision has changed.");
}
