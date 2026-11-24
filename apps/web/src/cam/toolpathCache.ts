import { restoreContourPreview, type CamResult, type ContourPreview } from "@whittle/cam";
import type { ToolpathInput } from "./toolpathInputs";
import type { GeneratedToolpath, ToolpathJob } from "./toolpathJob";

export type ToolpathStatus = "missing" | "valid" | "stale" | "generating" | "failed";
type CachedToolpath = Omit<GeneratedToolpath, "path"> & { path: ContourPreview };
type Result = CamResult<CachedToolpath>;
export interface ComputedToolpath {
  key: string;
  result: CamResult<GeneratedToolpath>;
}
type Outcome = Result | undefined;
interface Entry {
  valid?: { key: string; value: CachedToolpath };
  failure?: { key: string; errors: readonly string[] };
  pending?: { key: string; promise: Promise<Outcome> };
}

export class ToolpathCache {
  private entries = new Map<string, Entry>();
  private revision = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly run: (job: ToolpathJob, isCurrent: () => boolean) => Promise<CamResult<GeneratedToolpath>>) {}

  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private notify() {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }

  retain(ids: ReadonlySet<string>) {
    let changed = false;
    for (const id of this.entries.keys()) {
      if (!ids.has(id)) changed = this.entries.delete(id) || changed;
    }
    if (changed) this.notify();
  }

  inspect(id: string, key?: string) {
    const entry = this.entries.get(id);
    if (entry?.pending && entry.pending.key === key) return { status: "generating" } as const;
    if (entry?.failure && entry.failure.key === key) return { status: "failed", errors: entry.failure.errors } as const;
    if (entry?.valid && entry.valid.key === key) return { status: "valid", value: entry.valid.value } as const;
    return { status: entry?.valid ? "stale" : "missing" } as const;
  }

  generate(id: string, input: ToolpathInput, readCurrentKey: () => Promise<string | undefined>, computed?: ComputedToolpath): Promise<Outcome> {
    const entry = this.entries.get(id) ?? {};
    this.entries.set(id, entry);
    const { key, prepared } = input;
    if (entry.valid?.key === key) return Promise.resolve({ ok: true, value: entry.valid.value });
    if (entry.pending?.key === key) return entry.pending.promise;
    entry.failure = undefined;
    const isCurrent = () => this.entries.get(id) === entry && entry.pending === pending;
    const promise = Promise.resolve().then(async (): Promise<Outcome> => {
      let result: Result;
      try {
        const generated = computed?.key === key ? computed.result
          : prepared.ok ? await this.run(prepared.value, isCurrent) : prepared;
        result = generated.ok
          ? { ok: true, value: { ...generated.value, path: restoreContourPreview(generated.value.path) } }
          : generated;
      } catch (error) {
        result = { ok: false, errors: [String(error)] };
      }
      let currentKey: string | undefined;
      try {
        currentKey = isCurrent() ? await readCurrentKey() : undefined;
      } catch {
        // If current inputs cannot be resolved, the result cannot be certified.
      }
      if (!isCurrent()) return;
      entry.pending = undefined;
      if (currentKey === key) {
        if (result.ok) entry.valid = { key, value: result.value };
        else entry.failure = { key, errors: result.errors };
      }
      this.notify();
      return currentKey === key ? result : undefined;
    });
    const pending = { key, promise };
    entry.pending = pending;
    this.notify();
    return promise;
  }
}
