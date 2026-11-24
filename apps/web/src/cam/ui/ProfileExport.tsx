import { useLayoutEffect, useState, type FormEvent } from "react";
import { downloadApt } from "../downloadApt";
import { exportAptCl, type CircularProfileSettings } from "@whittle/cam";
import { useApp } from "../../state/store";
import type { ToolpathCache } from "../toolpathCache";

const dimensions = [
  ["diameter", "Flat endmill diameter (mm)"],
  ["depth", "Cut depth (mm)"],
  ["clearance", "Clearance above sketch (mm)"],
] as const;

const cuttingConditions = [
  ["feed", "Cut feed (mm/min)"],
  ["plungeFeed", "Plunge feed (mm/min)"],
  ["spindleRpm", "Spindle speed (rpm)"],
] as const;

type GenerationResult = Awaited<ReturnType<ToolpathCache["generate"]>>;

export function ProfileExport({ name, operationActive, settings = {}, onChange, toolpath, onGenerate, previewEnabled, hasContour, hasTool, toolDiameter, geometryAvailable }: {
  name: string;
  operationActive: boolean;
  hasContour: boolean;
  hasTool: boolean;
  toolDiameter?: number;
  settings?: CircularProfileSettings;
  onChange: (settings: Partial<CircularProfileSettings>) => void;
  toolpath?: ReturnType<ToolpathCache["inspect"]>;
  onGenerate: () => Promise<GenerationResult>;
  previewEnabled: boolean;
  geometryAvailable: boolean;
}) {
  const [errors, setErrors] = useState<readonly string[]>([]);
  const doc = useApp((s) => s.doc);
  const preview = operationActive && previewEnabled && toolpath?.status === "valid" ? toolpath.value : undefined;
  useLayoutEffect(() => {
    if (!preview) return;
    useApp.setState({ camContourPlayback: { doc, ...preview, showTool: true }, camContourProgress: 0 });
    return () => useApp.setState({ camContourPlayback: null, camContourProgress: 0 });
  }, [doc, preview]);

  async function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!operationActive) return;
    const result = await onGenerate();
    if (useApp.getState().doc !== doc) return;
    if (!result) {
      setErrors(["Toolpath generation was interrupted. Try again once the geometry is ready."]);
      return;
    }
    if (!result.ok) return;
    const apt = exportAptCl(result.value.profile!);
    if (!apt.ok) {
      setErrors(apt.errors);
      return;
    }
    setErrors([]);
    downloadApt(name, apt.value);
  }

  return (
    <form onSubmit={download} onChange={() => setErrors([])}>
      {hasContour && !geometryAvailable && <p>The profile sketch must be built and contain one circle.</p>}
      <dl>
        {hasContour && <>
          <dt><label htmlFor="cam-profile-side">Profile side</label></dt>
          <dd><select id="cam-profile-side" name="side" value={settings.side ?? "outside"}
            onChange={(event) => onChange({ side: event.target.value === "inside" ? "inside" : "outside" })}>
            <option value="outside">Outside</option><option value="inside">Inside</option>
          </select></dd>
          <dt><label htmlFor="cam-profile-direction">Cut direction</label></dt>
          <dd><select id="cam-profile-direction" name="direction" value={settings.direction ?? "ccw"}
            onChange={(event) => onChange({ direction: event.target.value === "cw" ? "cw" : "ccw" })}>
            <option value="ccw">Counterclockwise</option><option value="cw">Clockwise</option>
          </select></dd>
        </>}
        {hasContour && hasTool && <div>
          <dt>Flat endmill diameter (mm)</dt><dd>{toolDiameter ?? "Unavailable"}</dd>
        </div>}
        {[...(hasContour ? dimensions.filter(([key]) => key !== "diameter" || !hasTool) : []), ...cuttingConditions].map(([key, label]) => (
          <div key={key}>
            <dt><label htmlFor={`cam-profile-${key}`}>{label}</label></dt>
            <dd><input id={`cam-profile-${key}`} name={key} type="number" step="any" required={key !== "spindleRpm"} value={settings[key] ?? ""}
              onChange={(event) => onChange({ [key]: event.target.value })} /></dd>
          </div>
        ))}
      </dl>
      {hasContour && <div className="cam-properties__actions"><button type="submit" disabled={!geometryAvailable || !operationActive}>Export APT-CL</button></div>}
      <button type="button" disabled={!operationActive || toolpath?.status === "generating"} onClick={() => void onGenerate()}>Generate toolpath</button>
      {toolpath?.status === "failed" && <ul role="alert">{toolpath.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
      {errors.length > 0 && <ul role="alert">{errors.map((error) => <li key={error}>{error}</li>)}</ul>}
    </form>
  );
}
