import type { ReactNode } from "react";
import { manufacturingLabel, useCamWorkspace } from "./ui/CamWorkspace";
import { isNarrow, useApp } from "../state/store";
import { Toolbar } from "../ui/Chrome";
import { PropertiesPanel } from "../ui/PropertiesPanel";
import { Timeline } from "../ui/Timeline";
import { whittleCad } from "./whittleCad";

export function ManufacturingSlots({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  // The adapter reads current store state. Subscribe to the inputs that affect its answers.
  useApp((s) => s.selection);
  const doc = useApp((s) => s.doc);
  useApp((s) => s.regen);
  useApp((s) => s.builtDoc);
  const active = useApp((s) => s.ribbonTab === "manufacturing") && enabled;
  const openProperties = () => useApp.setState({ panelOpen: true, ...(isNarrow() ? { browserOpen: false } : {}) });
  const cam = useCamWorkspace(whittleCad, doc.id, openProperties);
  const ribbon = enabled ? {
    label: manufacturingLabel,
    activate: () => useApp.setState({ ribbonTab: "manufacturing", ...(isNarrow() ? { panelOpen: false } : {}) }),
    content: (
      <div className="toolgroup" role="group" aria-label="Setup and operations">
        <div className="toolgroup__tools">
          {cam.commands.map(({ id, label, icon: Icon, enabled, run }) => (
            <button className="tool" key={id} type="button" disabled={!enabled} aria-label={label} title={label}
              onClick={() => { run(); openProperties(); }}>
              <Icon />
              <span className="tool__label">{label}</span>
            </button>
          ))}
        </div>
        <span className="toolgroup__label">Setup and operations</span>
      </div>
    ),
  } : undefined;

  return (
    <>
      <Toolbar manufacturing={ribbon} />
      {children}
      <PropertiesPanel content={active ? cam.properties : undefined} />
      <Timeline content={active ? cam.timeline : undefined} />
    </>
  );
}
