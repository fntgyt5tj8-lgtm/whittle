import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { migrateWorkpieceContexts, plannedOperations, type CamProcess, type CamProject } from "@whittle/cam";
import type { WhittleDocument } from "@whittle/core";
import { useApp } from "../state/store";
import type { CamCadAdapter } from "./cadAdapter";
import { prepareToolpath, type ToolpathInput } from "./toolpathInputs";
import { runToolpathJob } from "./toolpathJob";
import { ToolpathCache, type ComputedToolpath } from "./toolpathCache";
import { ToolpathWorkers } from "./toolpathWorkers";

const workers = new ToolpathWorkers();

function waitForGeometry(doc: WhittleDocument): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), 60_000);
    const unsubscribe = useApp.subscribe(check);
    function finish(ready: boolean) {
      clearTimeout(timer);
      unsubscribe();
      resolve(ready);
    }
    function check() {
      const state = useApp.getState();
      if (state.doc !== doc || state.documentKind !== "cam" || state.kernelError) finish(false);
      else if (state.builtDoc === doc) finish(true);
    }
    check();
  });
}

export function useToolpathGeneration(cad: CamCadAdapter, documentId: string | undefined, project: CamProject) {
  const doc = useApp((state) => state.doc);
  const session = useApp((state) => state.camToolpathSession);
  const ready = useApp((state) => state.builtDoc === state.doc);
  const regen = useApp((state) => state.builtDoc === state.doc ? state.regen : null);
  const cache = useMemo(() => new ToolpathCache((job, current) => workers.run(job, current)), [session]);
  useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  const active = useMemo(() => plannedOperations(project), [project]);
  const inputs = useMemo(() => {
    if (!ready) return new Map<string, ToolpathInput>();
    return new Map(project.processes.map((item) => [item.id, prepareToolpath(cad, documentId, project, item)]));
  }, [cad, doc, documentId, project, ready, regen]);
  useLayoutEffect(() => {
    cache.retain(new Set(project.processes.map(({ id }) => id)));
  }, [cache, project]);
  useLayoutEffect(() => () => cache.retain(new Set()), [cache]);

  const get = (id: string) => cache.inspect(id, inputs.get(id)?.key);

  // A handle drag commits on pointer-up. Validate the proposed contour before saving it.
  function computeEdit(operation: CamProcess): ComputedToolpath {
    const { key, prepared } = prepareToolpath(cad, documentId, project, operation);
    return { key, result: prepared.ok ? runToolpathJob(prepared.value) : prepared };
  }

  async function generate(id: string, startDoc = doc, computed?: ComputedToolpath) {
    if (useApp.getState().builtDoc !== startDoc && !await waitForGeometry(startDoc)) return;
    const state = useApp.getState();
    if (state.doc !== startDoc || state.camToolpathSession !== session || state.documentKind !== "cam" || !state.doc.manufacturing) return;
    const currentProject = migrateWorkpieceContexts(state.doc.manufacturing);
    const operation = plannedOperations(currentProject).find((item) => item.id === id);
    if (!operation) return;
    const input = (startDoc === doc && regen === state.regen ? inputs.get(id) : undefined)
      ?? prepareToolpath(cad, documentId, currentProject, operation);
    return cache.generate(id, input, async () => {
      const latest = useApp.getState();
      if (latest.camToolpathSession !== session || latest.documentKind !== "cam" || latest.doc.id !== documentId || !latest.doc.manufacturing) return;
      if (latest.doc === startDoc && latest.builtDoc === startDoc && latest.regen === state.regen) return input.key;
      if (latest.builtDoc !== latest.doc && !await waitForGeometry(latest.doc)) return;
      const current = useApp.getState();
      if (current.camToolpathSession !== session || current.doc !== latest.doc || current.builtDoc !== current.doc || !current.doc.manufacturing) return;
      const nextProject = migrateWorkpieceContexts(current.doc.manufacturing);
      const item = plannedOperations(nextProject).find((item) => item.id === id);
      return item && prepareToolpath(cad, documentId, nextProject, item).key;
    }, computed);
  }

  const [batch, setBatch] = useState<{
    cache: ToolpathCache; total: number; done: number; reused: number; skipped: number; failures: string[];
  }>();
  const running = useRef<ToolpathCache | undefined>(undefined);
  const progress = batch?.cache === cache ? batch : undefined;

  async function generateAll() {
    if (!active.length || running.current === cache) return;
    running.current = cache;
    setBatch({ cache, total: active.length, done: 0, reused: 0, skipped: 0, failures: [] });
    // All current generators use independent geometry. Adaptive stay-down tracks only cuts within its own operation.
    await Promise.all(active.map(async (item) => {
      const reused = get(item.id).status === "valid";
      const result = reused ? undefined : await generate(item.id);
      setBatch((previous) => previous?.cache !== cache ? previous : {
        ...previous, done: previous.done + 1,
        reused: previous.reused + Number(reused),
        skipped: previous.skipped + Number(!reused && !result),
        failures: result && !result.ok ? [...previous.failures, ...result.errors.map((error) => `${item.name}: ${error}`)] : previous.failures,
      });
    }));
    if (running.current === cache) running.current = undefined;
  }

  return { get, generate, generateAll, computeEdit, progress, active, doc };
}
