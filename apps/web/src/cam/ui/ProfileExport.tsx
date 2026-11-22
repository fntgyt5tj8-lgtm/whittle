import { useState, type FormEvent } from "react";
import { CAM_WORLD, exportAptCl, generateCircularProfile, type CamFrame, type CircularProfileGeometry, type CircularProfileSettings } from "@whittle/cam";

const dimensions = [
  ["diameter", "Flat endmill diameter (mm)"],
  ["depth", "Cut depth (mm)"],
  ["clearance", "Clearance above sketch (mm)"],
  ["feed", "Cut feed (mm/min)"],
  ["plungeFeed", "Plunge feed (mm/min)"],
] as const;

export function ProfileExport({ name, resolve, settings = {}, onChange, datums, resolveDatum }: {
  name: string;
  settings?: CircularProfileSettings;
  onChange: (settings: Partial<CircularProfileSettings>) => void;
  datums: readonly { id: string; name: string }[];
  resolveDatum: (id: string) => CamFrame | undefined;
  resolve: () => CircularProfileGeometry | undefined;
}) {
  const [errors, setErrors] = useState<readonly string[]>([]);
  const geometryAvailable = !!resolve();
  const csys = settings.csys ?? "world";
  const missingDatum = csys !== "world" && csys !== "sketch" && !datums.some((datum) => `datum:${datum.id}` === csys);

  function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const geometry = resolve();
    if (!geometry) {
      setErrors(["The profile sketch is unavailable."]);
      return;
    }

    const workpieceCsys = csys === "world" ? CAM_WORLD
      : csys === "sketch" ? geometry.operationFrame : resolveDatum(csys.slice("datum:".length));
    if (!workpieceCsys) {
      setErrors(["The selected coordinate system is unavailable. Repair the datum or select another coordinate system."]);
      return;
    }

    const fields = new FormData(event.currentTarget);
    const read = (key: string) => Number(fields.get(key));
    const path = generateCircularProfile({
      geometry,
      workpieceCsys,
      tool: { kind: "flat-endmill", diameter: read("diameter") },
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
      {!geometryAvailable && <p>The profile sketch must be built and contain one circle.</p>}
      <dl>
        <dt><label htmlFor="cam-profile-csys">Workpiece CSYS</label></dt>
        <dd><select id="cam-profile-csys" value={csys}
          onChange={(event) => onChange({ csys: event.target.value as CircularProfileSettings["csys"] })}>
          <option value="world">Document origin</option>
          <option value="sketch">Sketch origin and axes</option>
          {datums.map((datum) => <option key={datum.id} value={`datum:${datum.id}`}>{datum.name}</option>)}
          {missingDatum && <option value={csys}>Coordinate system unavailable</option>}
        </select></dd>
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
        {dimensions.map(([key, label]) => (
          <div key={key}>
            <dt><label htmlFor={`cam-profile-${key}`}>{label}</label></dt>
            <dd><input id={`cam-profile-${key}`} name={key} type="number" step="any" required value={settings[key] ?? ""}
              onChange={(event) => onChange({ [key]: event.target.value })} /></dd>
          </div>
        ))}
      </dl>
      <div className="cam-properties__actions"><button type="submit" disabled={!geometryAvailable}>Export APT-CL</button></div>
      {errors.length > 0 && <ul role="alert">{errors.map((error) => <li key={error}>{error}</li>)}</ul>}
    </form>
  );
}
