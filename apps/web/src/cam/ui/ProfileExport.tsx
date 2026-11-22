import { useState, type FormEvent } from "react";
import { exportAptCl, generateCircularProfile, type CamFrame, type CircularProfileGeometry, type CircularProfileSettings } from "@whittle/cam";

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

export function ProfileExport({ name, resolve, settings = {}, onChange, resolveFrame, validateReferences, hasContour, hasTool, toolDiameter }: {
  name: string;
  hasContour: boolean;
  hasTool: boolean;
  toolDiameter?: number;
  settings?: CircularProfileSettings;
  onChange: (settings: Partial<CircularProfileSettings>) => void;
  validateReferences: () => readonly string[];
  resolveFrame: () => CamFrame | undefined;
  resolve: () => CircularProfileGeometry | undefined;
}) {
  const [errors, setErrors] = useState<readonly string[]>([]);
  const geometryAvailable = !!resolve();

  function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const geometry = resolve();
    if (!geometry) {
      setErrors(["The profile sketch is unavailable."]);
      return;
    }

    const workpieceCsys = resolveFrame();
    if (!workpieceCsys) {
      setErrors(["The context coordinate system is unavailable. Repair the datum or select another workpiece context."]);
      return;
    }

    const referenceErrors = validateReferences();
    if (referenceErrors.length) {
      setErrors(referenceErrors);
      return;
    }

    const fields = new FormData(event.currentTarget);
    const read = (key: string) => Number(fields.get(key));
    const path = generateCircularProfile({
      geometry,
      workpieceCsys,
      tool: { kind: "flat-endmill", diameter: toolDiameter ?? read("diameter") },
      side: fields.get("side") === "inside" ? "inside" : "outside",
      direction: fields.get("direction") === "cw" ? "cw" : "ccw",
      depth: read("depth"),
      clearance: read("clearance"),
      feed: read("feed"),
      plungeFeed: read("plungeFeed"),
    });
    const apt = path.ok ? exportAptCl(path.value) : path;
    if (!apt.ok) {
      setErrors(apt.errors);
      return;
    }

    setErrors([]);
    const url = URL.createObjectURL(new Blob([apt.value], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.apt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      {hasContour && <div className="cam-properties__actions"><button type="submit" disabled={!geometryAvailable}>Export APT-CL</button></div>}
      {errors.length > 0 && <ul role="alert">{errors.map((error) => <li key={error}>{error}</li>)}</ul>}
    </form>
  );
}
