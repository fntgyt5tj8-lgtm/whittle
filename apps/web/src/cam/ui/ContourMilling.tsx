import { Fragment, useEffect, useState } from "react";
import {
  CAM_WORLD, generateAdaptive, generateContour, generatePocket, isCamFrame, pocketBoundaries, transformCamVector, type CamBoundaryEdge, type ContourCurve, type ContourPoint, type CamFrame, type CamProcess, type CamToolPosition, type ContourMillingSettings, type PocketMillingSettings,
} from "@whittle/cam";
import { type CamContourPlayback, useApp } from "../../state/store";
import { modelEdges } from "../modelEdges";
import type { CamCadAdapter } from "../cadAdapter";

interface Props {
  cad: CamCadAdapter;
  process: CamProcess;
  settings: ContourMillingSettings | PocketMillingSettings;
  tool?: CamToolPosition;
  resolveFrame(): CamFrame | undefined;
  validateReferences(): string[];
  onGeometryChange(changes: Pick<Partial<CamProcess>, "boundaryEdges" | "islandEdges" | "floorFace">): void;
  onChange(settings: Partial<ContourMillingSettings & PocketMillingSettings>): void;
}

export function ContourMilling({ cad, process, settings, tool, resolveFrame, validateReferences, onChange, onGeometryChange }: Props) {
  const adaptive = process.kind === "adaptive";
  const label = adaptive ? "Adaptive clearing" : "stepover" in settings ? "Pocket milling" : "Contour milling";
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

  const setup = resolveFrame();
  const firstEdge = process.boundaryEdges?.[0];
  const firstEdgeGeometry = firstEdge && cad.resolveEdge?.(firstEdge);
  const sketch = firstEdge
    ? setup && firstEdgeGeometry && { ...setup, origin: firstEdgeGeometry.mid }
    : process.contour && cad.resolveSketchFrame(process.contour);
  const selectedEdges = cad.selectedEdges?.() ?? [];
  const selectedFloor = cad.selectedFloor?.();
  const floor = process.floorFace && cad.resolveFloor?.(process.floorFace);
  function addEdges(kind: "boundaryEdges" | "islandEdges") {
    const edges: CamBoundaryEdge[] = [...(process[kind] ?? [])];
    for (const edge of selectedEdges) {
      if (!edges.some((saved) => saved.bodyId === edge.bodyId && saved.length === edge.length
        && saved.curve === edge.curve && saved.mid.every((v, i) => v === edge.mid[i]))) edges.push(edge);
    }
    onGeometryChange({ [kind]: edges });
  }
  const floorDepth = floor && sketch && (() => {
    const normal = transformCamVector(floor.normal, CAM_WORLD, sketch, "direction");
    if (Math.abs(normal[2]) < 1 - 1e-8) return;
    const depth = -transformCamVector(floor.center, CAM_WORLD, sketch, "point")[2];
    return depth > 1e-5 ? depth : undefined;
  })();

  function generate() {
    setPlaying(false);
    seek(0);
    const fail = (errors: readonly string[]) => {
      useApp.setState({ camContourPlayback: null });
      setAttempt({ doc, errors });
    };
    const errors = validateReferences();
    if (errors.length) return fail(errors);
    if (!process.contour && !firstEdge) return fail(["Pick a sketch or add model boundary edges."]);
    if (!tool) return fail(["Assign a tool position to this operation."]);
    const cutting = cad.resolveToolCutting?.(tool.id);
    if (!cutting?.ok) return fail(cutting?.errors ?? ["The pinned cutting component is unavailable or still updating."]);
    if (cutting.value.family !== "FLAT") return fail([`${label} requires an inherited FLAT cutter TYPE.`]);
    const tip = cad.resolveCoordinateSystem(tool.tipCsysId);
    if (!tip || !isCamFrame(tip)) return fail(["Resolve the assigned tool's master TIP."]);
    const ids = tool.components.map((component) => component.bodyId);
    if (!ids.length || !cad.resolveToolBodies?.(ids)) return fail(["One or more physical tool components are missing or failed to build."]);
    if (!sketch || !setup || !isCamFrame(sketch)) return fail(["Resolve the boundary plane and workpiece coordinate system."]);
    if (process.floorFace && floorDepth === undefined) {
      return fail(["The floor must be available, parallel to the boundary, and below it."]);
    }
    const contour = firstEdge ? modelEdges(cad, process.boundaryEdges!, sketch, false)
      : cad.resolveContour?.(process.contour!);
    if (!contour?.ok) return fail(contour?.errors ?? ["The selected sketch is unavailable."]);
    if ("stepover" in settings) {
      const boundary = pocketBoundaries(contour.value);
      const name = firstEdge ? "Boundary edges" : cad.resolveGeometry(process.contour!)?.name ?? "Pocket boundary sketch";
      if (!boundary.ok) return fail(boundary.errors.map((error) => `${name} · ${error}`));
    }
    const islands: ContourCurve[] = [];
    for (const ref of process.islandSketches ?? []) {
      const name = cad.resolveGeometry(ref)?.name ?? "Island sketch";
      const geometry = cad.resolveContour?.(ref);
      const frame = cad.resolveSketchFrame(ref);
      if (!frame || !isCamFrame(frame) || !geometry?.ok || !geometry.value.length) {
        return fail([`${name} needs available closed sketch geometry.`, ...(geometry && !geometry.ok ? geometry.errors : [])]);
      }
      const island = pocketBoundaries(geometry.value);
      if (!island.ok) return fail(island.errors.map((error) => `${name} · ${error}`));
      const normal = transformCamVector(frame.z, CAM_WORLD, sketch, "direction");
      if (Math.abs(normal[2]) < 1 - 1e-10) return fail([`${name} must be parallel to the pocket boundary sketch.`]);
      const project = ([x, y]: ContourPoint): ContourPoint => {
        const [u, v] = transformCamVector([x, y, 0], frame, sketch, "point");
        return [u, v];
      };
      for (const curve of island.value.flat()) {
        if (curve.kind === "line") {
          islands.push({ kind: "line", a: project(curve.a), b: project(curve.b) });
        } else {
          const [u, v] = transformCamVector([Math.cos(curve.start), Math.sin(curve.start), 0], frame, sketch, "direction");
          islands.push({ ...curve, c: project(curve.c), start: Math.atan2(v, u), sweep: curve.sweep * Math.sign(normal[2]) });
        }
      }
    }
    if (process.islandEdges?.length) {
      const edges = modelEdges(cad, process.islandEdges, sketch, true);
      if (!edges.ok) return fail(edges.errors);
      const loops = pocketBoundaries(edges.value);
      if (!loops.ok) return fail(loops.errors.map((error) => `Island edges · ${error}`));
      islands.push(...loops.value.flat());
    }
    const effective = floorDepth === undefined ? settings : { ...settings, depth: String(floorDepth) };
    const generated = "stepover" in effective
      ? (adaptive ? generateAdaptive : generatePocket)(contour.value, sketch, setup, effective, cutting.value.diameter, islands)
      : generateContour(contour.value, sketch, setup, effective, cutting.value.diameter);
    if (!generated.ok) return fail(generated.errors);
    setAttempt(undefined);
    const preview: CamContourPlayback = { doc, path: generated.value, tip, ids, showTool: true };
    useApp.setState({ camContourPlayback: preview });
  }

  return <section aria-label={label} className="cam-contour">
    <div className="cam-properties__actions">
      <button type="button" disabled={!selectedEdges.length} onClick={() => addEdges("boundaryEdges")}>Add selected boundary edges</button>
      {firstEdge && <button type="button" onClick={() => onGeometryChange({ boundaryEdges: undefined })}>Clear boundary edges</button>}
      {"stepover" in settings && <>
        <button type="button" disabled={!selectedEdges.length} onClick={() => addEdges("islandEdges")}>Add selected island edges</button>
        {!!process.islandEdges?.length && <button type="button" onClick={() => onGeometryChange({ islandEdges: undefined })}>Clear island edges</button>}
      </>}
      <button type="button" disabled={!selectedFloor} onClick={() => onGeometryChange({ floorFace: selectedFloor })}>Use selected face as floor</button>
      {process.floorFace && <button type="button" onClick={() => onGeometryChange({ floorFace: undefined })}>Clear floor</button>}
    </div>
    {(firstEdge || !!process.islandEdges?.length) && <p>
      {process.boundaryEdges?.length ?? 0} boundary edges · {process.islandEdges?.length ?? 0} island edges
    </p>}
    <dl>
      {"stepover" in settings ? <>
        <dt><label htmlFor="cam-pocket-stepover">{adaptive ? "Target radial engagement (% of cutter diameter)" : "Stepover (% of cutter diameter)"}</label></dt>
        <dd><input id="cam-pocket-stepover" type="number" min={adaptive ? 1 : 0} max="50" step="any" value={settings.stepover}
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
      {adaptive && "stepover" in settings && <>
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
      <dt><label htmlFor="cam-contour-depth">Depth (mm)</label></dt>
      <dd><input id="cam-contour-depth" type="number" min="0" step="any" readOnly={!!process.floorFace} value={process.floorFace ? floorDepth?.toPrecision(8) ?? "" : settings.depth}
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
    <p>Depth below the boundary plane. Clearance above it.</p>
    {"stepover" in settings && <p>Nested loops and added island sketches define areas to leave uncut.</p>}
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
        <span>{"stepover" in settings ? "Pocket boundary" : "Programmed contour"}</span><span>Tool centerline</span><span>Entry / retract / link</span>
      </p>
    </>}
  </section>;
}
