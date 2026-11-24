import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { contourTravel, type CamBoundaryEdge, type CamFrame, type CamProcess, type ContourMillingSettings, type FacingMillingSettings, type PocketMillingSettings } from "@whittle/cam";
import { type CamContourPlayback, useApp } from "../../state/store";
import { millingGeometry } from "../milling";
import type { ComputedToolpath, ToolpathCache } from "../toolpathCache";
import type { CamCadAdapter } from "../cadAdapter";

interface Props {
  cad: CamCadAdapter;
  operationActive: boolean;
  process: CamProcess;
  settings: ContourMillingSettings | PocketMillingSettings | FacingMillingSettings;
  toolpath?: ReturnType<ToolpathCache["inspect"]>;
  onGenerate(computed?: ComputedToolpath): Promise<unknown>;
  computeEdit(process: CamProcess): ComputedToolpath;
  resolveFrame(): CamFrame | undefined;
  onGeometryChange(changes: Pick<Partial<CamProcess>, "boundaryEdges" | "islandEdges" | "floorFace" | "facingFace" | "contour">): void;
  onChange(settings: Partial<ContourMillingSettings & PocketMillingSettings & FacingMillingSettings>): void;
}

export function ContourMilling({ cad, process, settings, operationActive, toolpath, onGenerate, computeEdit, resolveFrame, onChange, onGeometryChange }: Props) {
  const adaptive = process.kind === "adaptive";
  const facing = "strategy" in settings;
  const label = facing ? "Facing milling" : adaptive ? "Adaptive clearing" : "stepover" in settings ? "Pocket milling" : "Contour milling";
  const doc = useApp((s) => s.doc);
  const cached = operationActive && toolpath?.status === "valid" ? toolpath.value : undefined;
  const playback = useApp((s) => s.camContourPlayback?.doc === s.doc ? s.camContourPlayback : null);
  const preserveCamera = useRef(false);
  const display = useRef<Pick<CamContourPlayback, "showTool" | "showCenterline">>({ showTool: true });
  const editRef = useRef<NonNullable<CamContourPlayback["editContour"]>>(() => {});
  useLayoutEffect(() => () => {
    useApp.setState({ camContourPlayback: null, camContourProgress: 0 });
  }, []);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [editError, setEditError] = useState<{ doc: typeof doc; errors: readonly string[] }>();

  useLayoutEffect(() => {
    setPlaying(false);
    setProgress(0);
    const previous = useApp.getState().camContourPlayback;
    if (previous) display.current = { showTool: previous.showTool, showCenterline: previous.showCenterline };
    useApp.setState({
      camContourProgress: 0,
      camContourPlayback: cached ? {
        doc, path: cached.path, tip: cached.tip, ids: cached.ids,
        ...display.current,
        preserveCamera: preserveCamera.current,
        editContour: (key, value) => editRef.current(key, value),
      } : null,
    });
    if (cached) preserveCamera.current = false;
  }, [cached, doc]);

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
  function generate(changes?: Partial<ContourMillingSettings>, drag = false) {
    if (useApp.getState().doc !== doc) return;
    setEditError(undefined);
    const computed = drag && operationActive && process.contourMilling
      ? computeEdit({ ...process, contourMilling: { ...process.contourMilling, ...changes } }) : undefined;
    if (computed && !computed.result.ok) {
      setEditError({ doc, errors: computed.result.errors });
      return;
    }
    if (changes) {
      preserveCamera.current = true;
      onChange(changes);
    }
    if (!operationActive) return;
    setPlaying(false);
    seek(0);
    void onGenerate(computed);
  }

  editRef.current = (key, value) => generate({ [key]: String(value) }, true);
  const isContour = !("stepover" in settings);
  const millingDirection = isContour ? settings.millingDirection ?? "manual" : "manual";
  const automaticTravel = isContour && settings.side !== "center" && millingDirection !== "manual";

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
      <dt><label htmlFor="cam-contour-milling-direction">Milling direction</label></dt>
      <dd><select id="cam-contour-milling-direction" value={millingDirection}
        onChange={(event) => onChange({ millingDirection: event.target.value as ContourMillingSettings["millingDirection"] })}>
        <option value="climb">Climb</option>
        <option value="conventional">Conventional</option>
        <option value="manual">Manual travel</option>
      </select></dd>
      {automaticTravel && <>
        <dt><label htmlFor="cam-contour-spindle-direction">Spindle rotation (viewed toward the work)</label></dt>
        <dd><select id="cam-contour-spindle-direction" value={settings.spindleDirection ?? "cw"}
          onChange={(event) => onChange({ spindleDirection: event.target.value === "ccw" ? "ccw" : "cw" })}>
          <option value="cw">Clockwise</option>
          <option value="ccw">Counterclockwise</option>
        </select></dd>
      </>}
      {!automaticTravel && <>
      <dt><label htmlFor="cam-contour-direction">Travel direction</label></dt>
      <dd><select id="cam-contour-direction" value={settings.direction}
        onChange={(event) => onChange({ direction: event.target.value as ContourMillingSettings["direction"] })}>
        <option value="forward">Forward</option><option value="reverse">Reverse</option>
      </select></dd>
      </>}
      <dt><label htmlFor="cam-contour-side">Machining side</label></dt>
      <dd><select id="cam-contour-side" value={settings.side}
        onChange={(event) => onChange({ side: event.target.value as ContourMillingSettings["side"] })}>
        <option value="center">Center</option>
        <option value="left">{automaticTravel ? "Left of reference travel" : "Left of travel"}</option>
        <option value="right">{automaticTravel ? "Right of reference travel" : "Right of travel"}</option>
      </select></dd>
      {automaticTravel && <>
        <dt>Effective compensation</dt>
        <dd>{contourTravel(settings).side === "left" ? "Left of cutting travel" : "Right of cutting travel"}</dd>
      </>}
      <dt><label htmlFor="cam-contour-optimise-retracts">Optimise retracts</label></dt>
      <dd><input id="cam-contour-optimise-retracts" type="checkbox" checked={settings.optimiseRetracts ?? false}
        onChange={(event) => onChange({ optimiseRetracts: event.target.checked })} /></dd>
      <dt><label htmlFor="cam-contour-cutcom">Export CUTCOM (machine R=0)</label></dt>
      <dd><input id="cam-contour-cutcom" type="checkbox" disabled={settings.side === "center"}
        checked={settings.side !== "center" && (settings.aptCutcom ?? false)}
        onChange={(event) => onChange({ aptCutcom: event.target.checked })} /></dd>
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
          ["stockAllowance", "Starting radial stock allowance (mm)", settings.stockAllowance],
          ["radialIncrement", "Radial pass increment (mm)", settings.radialIncrement],
          ["finishAllowance", "Finish radial stock allowance (mm)", settings.finishAllowance],
          ["leadIn", "Tangent lead-in (mm)", settings.leadIn],
          ["arcLeadIn", "Tangent arc lead-in (°)", settings.arcLeadIn],
          ["arcLeadInRadius", "Lead-in arc radius (mm)", settings.arcLeadInRadius],
          ["normalLeadIn", "Normal lead-in (mm)", settings.normalLeadIn],
          ["leadOut", "Tangent lead-out (mm)", settings.leadOut],
          ["arcLeadOut", "Tangent arc lead-out (°)", settings.arcLeadOut],
          ["arcLeadOutRadius", "Lead-out arc radius (mm)", settings.arcLeadOutRadius],
          ["normalLeadOut", "Normal lead-out (mm)", settings.normalLeadOut],
        ] as const),
      ] as const).map(([key, label, value]) => <Fragment key={key}>
        <dt><label htmlFor={`cam-contour-${key}`}>{label}</label></dt>
        <dd><input id={`cam-contour-${key}`} type="number" min="0" step="any"
          max={key === "arcLeadIn" || key === "arcLeadOut" ? 180 : undefined}
          disabled={key === "finishAllowance" && isContour && !(Number(settings.radialIncrement) > 0)}
          placeholder={key === "stepdown" ? "Single pass" : key.endsWith("Radius") ? "Cutter radius" : "0"} value={value ?? ""}
          onChange={(event) => {
            if (key === "stepdown") onChange({ stepdown: event.target.value });
            else {
              const change = { [key]: event.target.value };
              if (playback || toolpath?.status === "failed" || preserveCamera.current) generate(change);
              else onChange(change);
            }
          }} /></dd>
      </Fragment>)}
      {isContour && <Fragment>
        <dt><label htmlFor="cam-contour-seam">Closed contour seam (0–1)</label></dt>
        <dd><input id="cam-contour-seam" type="number" min="0" max="1" step="any"
          value={settings.seam ?? "0"} onChange={(event) => {
            const change = { seam: event.target.value };
            if (playback || toolpath?.status === "failed" || preserveCamera.current) generate(change);
            else onChange(change);
          }} /></dd>
      </Fragment>}
    </dl>
    <p>{facing ? "Top and final heights are relative to the boundary plane. Clearance is above both the top and boundary plane."
      : "Depth below the boundary plane. Clearance above it."}</p>
    {isContour && settings.side === "center" && millingDirection !== "manual" && <p>Select a machining side to set climb or conventional travel.</p>}
    {isContour && <p>Set a radial increment to cut from the starting allowance down to the finish allowance at each depth.</p>}
    {isContour && <p>From the contour outward, the tangent line comes first, followed by the tangent arc and normal line. Zero turns a move off.</p>}
    {facing && <p>Facing sweeps the full bounding rectangle, including outside the selected surface. Use one closed loop with room for cutter overtravel.</p>}
    {!facing && "stepover" in settings && <p>Nested loops and added island sketches define areas to leave uncut.</p>}
    <div className="cam-properties__actions">
      <button type="button" disabled={!operationActive || toolpath?.status === "generating"} onClick={() => generate()}>Generate toolpath</button>
      <button type="button" disabled={!playback} onClick={() => {
        if (!playing && progress >= 1) seek(0);
        setPlaying(!playing);
      }}>{playing ? "Pause" : "Play"}</button>
      <button type="button" disabled={!playback} onClick={() => { setPlaying(false); seek(0); }}>Reset</button>
      {isContour && <button type="button" onClick={() => generate({
        leadIn: "0", arcLeadIn: "0", arcLeadInRadius: "", normalLeadIn: "0",
        leadOut: "0", arcLeadOut: "0", arcLeadOutRadius: "", normalLeadOut: "0", seam: "0",
      })}>
        Reset entry and exit
      </button>}
    </div>
    {editError?.doc === doc && <ul role="alert">{editError.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
    {toolpath?.status === "failed" && <ul role="alert">{toolpath.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
    {playback && <>
      {playback.path.contourHandles?.some(({ key }) => key === "seam") && <p>Drag the blue seam handle to move the start and end along the tool centerline.</p>}
      {playback.path.contourHandles?.some(({ key }) => key !== "seam") && <p>Drag the available green entry or orange exit handles along their endpoint tangents.</p>}
      {playback.path.stayDownLinkCount !== undefined && <p role="status">
        {playback.path.stayDownLinkCount > 0
          ? isContour
            ? `${playback.path.stayDownLinkCount} same-depth feed links.`
            : `${playback.path.stayDownLinkCount} stay-down links (${playback.path.stayDownCutLinkCount ?? 0} short cutting links, ${playback.path.routedStayDownLinkCount ?? 0} routed).`
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
