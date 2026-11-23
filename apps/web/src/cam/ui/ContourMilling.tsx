import { Fragment, useEffect, useState } from "react";
import type { CamBoundaryEdge, CamFrame, CamProcess, CamToolPosition, ContourMillingSettings, FacingMillingSettings, PocketMillingSettings } from "@whittle/cam";
import { type CamContourPlayback, useApp } from "../../state/store";
import { generateMilling, millingGeometry } from "../milling";
import type { CamCadAdapter } from "../cadAdapter";

interface Props {
  cad: CamCadAdapter;
  process: CamProcess;
  settings: ContourMillingSettings | PocketMillingSettings | FacingMillingSettings;
  tool?: CamToolPosition;
  resolveFrame(): CamFrame | undefined;
  validateReferences(): string[];
  onGeometryChange(changes: Pick<Partial<CamProcess>, "boundaryEdges" | "islandEdges" | "floorFace" | "facingFace" | "contour">): void;
  onChange(settings: Partial<ContourMillingSettings & PocketMillingSettings & FacingMillingSettings>): void;
}

export function ContourMilling({ cad, process, settings, tool, resolveFrame, validateReferences, onChange, onGeometryChange }: Props) {
  const adaptive = process.kind === "adaptive";
  const facing = "strategy" in settings;
  const label = facing ? "Facing milling" : adaptive ? "Adaptive clearing" : "stepover" in settings ? "Pocket milling" : "Contour milling";
  const doc = useApp((s) => s.doc);
  const [attempt, setAttempt] = useState<{ doc: typeof doc; errors: readonly string[] }>();
  const playback = useApp((s) => s.camContourPlayback?.doc === s.doc ? s.camContourPlayback : null);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setPlaying(false);
    setProgress(0);
    return () => useApp.setState({ camContourPlayback: null, camContourProgress: 0 });
  }, [doc]);

  function seek(value: number) {
    setProgress(value);
    useApp.setState({ camContourProgress: value });
  }

  useEffect(() => {
    if (!playing || !playback) return;
    const duration = Math.max(2500, Math.min(30000, playback.path.length * 100));
    const start = performance.now() - progress * duration;
    let frame = requestAnimationFrame(function advance(now) {
      const position = Math.min(1, (now - start) / duration);
      seek(position);
      if (position < 1) frame = requestAnimationFrame(advance);
      else setPlaying(false);
    });
    return () => cancelAnimationFrame(frame);
    // Progress is read at the start of playback. Scrubbing pauses playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playback?.path]);

  const { firstEdge, floorDepth } = millingGeometry(cad, doc.id, process, resolveFrame());
  const selectedEdges = cad.selectedEdges?.() ?? [];
  const selectedFloor = cad.selectedFloor?.();
  function addEdges(kind: "boundaryEdges" | "islandEdges") {
    const edges: CamBoundaryEdge[] = [...(process[kind] ?? [])];
    for (const edge of selectedEdges) {
      if (!edges.some((saved) => saved.bodyId === edge.bodyId && saved.length === edge.length
        && saved.curve === edge.curve && saved.mid.every((v, i) => v === edge.mid[i]))) edges.push(edge);
    }
    onGeometryChange(facing ? { boundaryEdges: edges, facingFace: undefined, contour: undefined } : { [kind]: edges });
  }
  function generate() {
    setPlaying(false);
    seek(0);
    const generated = generateMilling(cad, doc.id, process, settings, tool, resolveFrame(), validateReferences());
    if (!generated.ok) {
      useApp.setState({ camContourPlayback: null });
      setAttempt({ doc, errors: generated.errors });
      return;
    }
    setAttempt(undefined);
    const preview: CamContourPlayback = { doc, ...generated.value, showTool: true };
    useApp.setState({ camContourPlayback: preview });
  }

  return <section aria-label={label} className="cam-contour">
    <div className="cam-properties__actions">
      <button type="button" disabled={!selectedEdges.length} onClick={() => addEdges("boundaryEdges")}>Add selected boundary edges</button>
      {firstEdge && <button type="button" onClick={() => onGeometryChange({ boundaryEdges: undefined })}>Clear boundary edges</button>}
      {!facing && "stepover" in settings && <>
        <button type="button" disabled={!selectedEdges.length} onClick={() => addEdges("islandEdges")}>Add selected island edges</button>
        {!!process.islandEdges?.length && <button type="button" onClick={() => onGeometryChange({ islandEdges: undefined })}>Clear island edges</button>}
      </>}
      {!facing && <><button type="button" disabled={!selectedFloor} onClick={() => onGeometryChange({ floorFace: selectedFloor })}>Use selected face as floor</button>
      {process.floorFace && <button type="button" onClick={() => onGeometryChange({ floorFace: undefined })}>Clear floor</button>}</>}
    </div>
    {(firstEdge || !!process.islandEdges?.length) && <p>
      {process.boundaryEdges?.length ?? 0} boundary edges · {process.islandEdges?.length ?? 0} island edges
    </p>}
    <dl>
      {facing && <>
        <dt><label htmlFor="cam-facing-strategy">Raster strategy</label></dt>
        <dd><select id="cam-facing-strategy" value={settings.strategy}
          onChange={(event) => onChange({ strategy: event.target.value === "one-way" ? "one-way" : "zigzag" })}>
          <option value="zigzag">Zigzag</option><option value="one-way">One-way</option>
        </select></dd>
        <dt><label htmlFor="cam-facing-top">Top height (mm)</label></dt>
        <dd><input id="cam-facing-top" type="number" step="any" value={settings.top}
          onChange={(event) => onChange({ top: event.target.value })} /></dd>
      </>}
      {"stepover" in settings ? <>
        <dt><label htmlFor="cam-pocket-stepover">{adaptive ? "Target radial engagement (% of cutter diameter)" : "Stepover (% of cutter diameter)"}</label></dt>
        <dd><input id="cam-pocket-stepover" type="number" min={adaptive ? 1 : 0} max={facing ? 100 : 50} step="any" value={settings.stepover}
          onChange={(event) => onChange({ stepover: event.target.value })} /></dd>
      </> : <>
      <dt><label htmlFor="cam-contour-direction">Travel direction</label></dt>
      <dd><select id="cam-contour-direction" value={settings.direction}
        onChange={(event) => onChange({ direction: event.target.value as ContourMillingSettings["direction"] })}>
        <option value="forward">Forward</option><option value="reverse">Reverse</option>
      </select></dd>
      <dt><label htmlFor="cam-contour-side">Machining side</label></dt>
      <dd><select id="cam-contour-side" value={settings.side}
        onChange={(event) => onChange({ side: event.target.value as ContourMillingSettings["side"] })}>
        <option value="center">Center</option><option value="left">Left of travel</option><option value="right">Right of travel</option>
      </select></dd>
      </>}
      {adaptive && !facing && "stepover" in settings && <>
        <dt><label htmlFor="cam-adaptive-entry">Entry</label></dt>
        <dd><select id="cam-adaptive-entry" value={settings.entry ?? "plunge"}
          onChange={(event) => onChange({ entry: event.target.value === "helix" ? "helix" : "plunge" })}>
          <option value="plunge">Vertical plunge</option>
          <option value="helix">Helical ramp</option>
        </select></dd>
        <dt><label htmlFor="cam-adaptive-stay-down">Stock-aware linking</label></dt>
        <dd><input id="cam-adaptive-stay-down" type="checkbox" checked={settings.stayDown ?? false}
          onChange={(event) => onChange({ stayDown: event.target.checked })} /></dd>
        {settings.entry === "helix" && <>
          <dt><label htmlFor="cam-helix-diameter">Helix orbit diameter (mm)</label></dt>
          <dd><input id="cam-helix-diameter" type="number" min="0" step="any" placeholder="Half the cutter diameter"
            value={settings.helixDiameter ?? ""} onChange={(event) => onChange({ helixDiameter: event.target.value })} /></dd>
          <dt><label htmlFor="cam-ramp-angle">Maximum ramp angle (°)</label></dt>
          <dd><input id="cam-ramp-angle" type="number" min="1" max="15" step="any" placeholder="3"
            value={settings.rampAngle ?? ""} onChange={(event) => onChange({ rampAngle: event.target.value })} /></dd>
        </>}
      </>}
      <dt><label htmlFor="cam-contour-depth">{facing ? "Final height (mm)" : "Depth (mm)"}</label></dt>
      <dd><input id="cam-contour-depth" type="number" min={facing ? undefined : 0} step="any" readOnly={!!process.floorFace} value={process.floorFace ? floorDepth?.toPrecision(8) ?? "" : settings.depth}
        onChange={(event) => onChange({ depth: event.target.value })} /></dd>
      <dt><label htmlFor="cam-contour-clearance">Clearance (mm)</label></dt>
      <dd><input id="cam-contour-clearance" type="number" min="0" step="any" value={settings.clearance}
        onChange={(event) => onChange({ clearance: event.target.value })} /></dd>
      {([
        ["stepdown", "Maximum stepdown (mm)", settings.stepdown],
        ...("stepover" in settings ? [] : [
          ["leadIn", "Tangent lead-in (mm)", settings.leadIn],
          ["leadOut", "Tangent lead-out (mm)", settings.leadOut],
        ] as const),
      ] as const).map(([key, label, value]) => <Fragment key={key}>
        <dt><label htmlFor={`cam-contour-${key}`}>{label}</label></dt>
        <dd><input id={`cam-contour-${key}`} type="number" min="0" step="any"
          placeholder={key === "stepdown" ? "Single pass" : "0"} value={value ?? ""}
          onChange={(event) => onChange({ [key]: event.target.value })} /></dd>
      </Fragment>)}
    </dl>
    <p>{facing ? "Top and final heights are relative to the boundary plane. Clearance is above both the top and boundary plane."
      : "Depth below the boundary plane. Clearance above it."}</p>
    {facing && <p>Facing sweeps the full bounding rectangle, including outside the selected surface. Use one closed loop with room for cutter overtravel.</p>}
    {!facing && "stepover" in settings && <p>Nested loops and added island sketches define areas to leave uncut.</p>}
    <div className="cam-properties__actions">
      <button type="button" onClick={generate}>Generate toolpath</button>
      <button type="button" disabled={!playback} onClick={() => {
        if (!playing && progress >= 1) seek(0);
        setPlaying(!playing);
      }}>{playing ? "Pause" : "Play"}</button>
      <button type="button" disabled={!playback} onClick={() => { setPlaying(false); seek(0); }}>Reset</button>
    </div>
    {attempt?.doc === doc && <ul role="alert">{attempt.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
    {playback && <>
      {playback.path.stayDownLinkCount !== undefined && <p role="status">
        {playback.path.stayDownLinkCount > 0
          ? `${playback.path.stayDownLinkCount} stay-down links (${playback.path.stayDownCutLinkCount ?? 0} short cutting links, ${playback.path.routedStayDownLinkCount ?? 0} routed).`
          : "All links use clearance."}
      </p>}
      {!!playback.path.adaptiveTransitionCuts && <p role="status">
        {playback.path.adaptiveTransitionCuts} initial or transition {playback.path.adaptiveTransitionCuts === 1 ? "cut" : "cuts"} per depth may exceed target engagement.
      </p>}
      <label className="cam-contour__scrub">Playback timeline
        <input type="range" min="0" max="1" step="0.001" value={progress} onChange={(event) => {
          setPlaying(false);
          seek(Number(event.target.value));
        }} />
      </label>
      <label><input type="checkbox" checked={playback.showTool} onChange={(event) => {
        useApp.setState({ camContourPlayback: { ...playback, showTool: event.target.checked } });
      }} /> Show tool assembly</label>
      <label><input type="checkbox" checked={playback.showCenterline !== false} onChange={(event) => {
        useApp.setState({ camContourPlayback: { ...playback, showCenterline: event.target.checked } });
      }} /> Show tool centerline</label>
      <p className="cam-contour__legend">
        <span>{facing ? "Facing boundary" : "stepover" in settings ? "Pocket boundary" : "Programmed contour"}</span><span>Tool centerline</span><span>Entry / retract / link</span>
      </p>
    </>}
  </section>;
}
