import type { Draft } from "immer";
import { createProject, migrateWorkpieceContexts, type CamProject } from "@whittle/cam";
import { useEffect, useMemo, type ReactNode } from "react";
import { manufacturingLabel, useCamWorkspace } from "./ui/CamWorkspace";
import { isNarrow, mutate, useApp } from "../state/store";
import { commandById } from "../state/commands";
import { Toolbar, ToolButton } from "../ui/Chrome";
import { PropertiesPanel } from "../ui/PropertiesPanel";
import { Timeline } from "../ui/Timeline";
import { ToolProperties } from "./ui/ToolPositions";
import { whittleCad } from "./whittleCad";

const emptyProject = createProject("Manufacturing project");

export function ManufacturingSlots({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  // The adapter reads current store state. Subscribe to the inputs that affect its answers.
  useApp((s) => s.selection);
  const doc = useApp((s) => s.doc);
  const regen = useApp((s) => s.builtDoc === s.doc ? s.regen : null);
  const isCam = useApp((s) => s.documentKind === "cam");
  const active = useApp((s) => s.ribbonTab === "manufacturing") && enabled && isCam;
  const toolSelection = useApp((s) => s.camToolSelection);
  const editing = useApp((s) => !!s.session);
  const openProperties = () => useApp.setState({ camToolSelection: null, panelOpen: true, ...(isNarrow() ? { browserOpen: false } : {}) });
  function saveProject(update: (current: CamProject) => CamProject, label: string, mergeKey?: string) {
    const state = useApp.getState();
    if (state.documentKind !== "cam" || state.doc.id !== doc.id) return;
    const current = state.doc.manufacturing ?? emptyProject;
    const migrated = migrateWorkpieceContexts(current);
    const next = update(migrated);
    if (next !== migrated) {
      mutate(label, (draft) => { draft.manufacturing = next as Draft<CamProject>; }, mergeKey);
    }
  }
  const imports = isCam && regen ? doc.features.filter((f) => f.type === "import" && f.cadSource) : [];
  const sourceErrors = imports.flatMap((f) => {
    const status = regen?.status.find(({ id }) => id === f.id);
    return status?.state === "error" ? [`${f.name}: ${status.message ?? "CAD source unavailable."}`] : [];
  });
  const storedProject = (isCam && doc.manufacturing) || emptyProject;
  const project = useMemo(() => migrateWorkpieceContexts(storedProject), [storedProject]);
  const cam = useCamWorkspace(whittleCad, doc.id, project,
    saveProject, openProperties, sourceErrors, active && !editing && !toolSelection,
    () => useApp.setState({ selection: [], hover: null, camBrowserTab: "browser" }));
  useEffect(() => {
    useApp.setState({ camProfileSketchPicking: cam.pickingSketch, camOrientationFacePicking: cam.pickingFace });
    return () => useApp.setState({ camProfileSketchPicking: false, camOrientationFacePicking: false });
  }, [cam.pickingSketch, cam.pickingFace]);
  const ribbon = enabled ? {
    label: manufacturingLabel,
    activate: () => useApp.setState({ ribbonTab: "manufacturing", ...(isNarrow() ? { panelOpen: false } : {}) }),
    content: (
      <div className="cam-document-actions" role="group" aria-label="CAM document and geometry commands">
        {["new-cam", "open-cam", "save-cam", "save-cam-as",
          ...(!isCam && doc.manufacturing ? ["migrate-cam"] : []),
          ...(isCam ? ["parts", "import", "move", "plane", "csys", "sketch", "verify-cad-source"] : []),
        ].map((id) => <ToolButton key={id} c={commandById(id)} />)}
      </div>
    ),
  } : undefined;

  return (
    <>
      <Toolbar manufacturing={ribbon} />
      {children}
      <PropertiesPanel content={active && !editing ? (toolSelection ? <ToolProperties /> : cam.properties) : undefined} />
      <Timeline content={active ? cam.timeline : undefined} />
    </>
  );
}
