import { useState, type FormEvent } from "react";
import { CAM_WORLD, exportAptCl, generateCircularProfile, type CircularProfileGeometry } from "@whittle/cam";

const dimensions = [
  ["diameter", "Flat endmill diameter (mm)"],
  ["depth", "Cut depth (mm)"],
  ["clearance", "Clearance above sketch (mm)"],
  ["feed", "Cut feed (mm/min)"],
  ["plungeFeed", "Plunge feed (mm/min)"],
] as const;

export function ProfileExport({ name, resolve }: {
  name: string;
  resolve: () => CircularProfileGeometry | undefined;
}) {
  const [errors, setErrors] = useState<readonly string[]>([]);
  if (!resolve()) return <p>Select a sketch with one circle before adding a profile to export APT-CL.</p>;

  function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const geometry = resolve();
    if (!geometry) {
      setErrors(["The profile sketch is unavailable."]);
      return;
    }

    const fields = new FormData(event.currentTarget);
    const read = (key: string) => Number(fields.get(key));
    const path = generateCircularProfile({
      geometry,
      workpieceCsys: fields.get("csys") === "sketch" ? geometry.operationFrame : CAM_WORLD,
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
      <dl>
        <dt><label htmlFor="cam-profile-csys">Workpiece CSYS</label></dt>
        <dd><select id="cam-profile-csys" name="csys">
          <option value="world">Document origin</option>
          <option value="sketch">Sketch origin and axes</option>
        </select></dd>
        <dt><label htmlFor="cam-profile-side">Profile side</label></dt>
        <dd><select id="cam-profile-side" name="side">
          <option value="outside">Outside</option><option value="inside">Inside</option>
        </select></dd>
        <dt><label htmlFor="cam-profile-direction">Cut direction</label></dt>
        <dd><select id="cam-profile-direction" name="direction">
          <option value="ccw">Counterclockwise</option><option value="cw">Clockwise</option>
        </select></dd>
        {dimensions.map(([key, label]) => (
          <div key={key}>
            <dt><label htmlFor={`cam-profile-${key}`}>{label}</label></dt>
            <dd><input id={`cam-profile-${key}`} name={key} type="number" step="any" required /></dd>
          </div>
        ))}
      </dl>
      <div className="cam-properties__actions"><button type="submit">Export APT-CL</button></div>
      {errors.length > 0 && <ul role="alert">{errors.map((error) => <li key={error}>{error}</li>)}</ul>}
    </form>
  );
}
