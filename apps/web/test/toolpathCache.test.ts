import { describe, expect, it } from "vitest";
import { CAM_WORLD } from "@whittle/cam";
import { ToolpathCache } from "../src/cam/toolpathCache";
import type { ToolpathInput } from "../src/cam/toolpathInputs";
import { runToolpathJob, type ToolpathJob } from "../src/cam/toolpathJob";

const job: ToolpathJob = {
  kind: "profile", ids: [], tip: CAM_WORLD,
  input: {
    geometry: { center: [0, 0], radius: 5, operationFrame: CAM_WORLD },
    workpieceCsys: CAM_WORLD, tool: { kind: "flat-endmill", diameter: 2 },
    direction: "ccw", side: "outside", depth: 1, clearance: 2, feed: 100, plungeFeed: 50,
  },
};
const input = (key: string): ToolpathInput => ({ key, prepared: { ok: true, value: job } });
const generated = runToolpathJob(job);
const readKey = (key: string) => async () => key;

describe("operation toolpath cache", () => {
  it("shares pending work, restores a cloneable preview, and reuses the valid result", async () => {
    let calls = 0;
    const cache = new ToolpathCache(async () => { calls++; return structuredClone(generated); });
    expect(cache.inspect("op", "a").status).toBe("missing");
    const pending = cache.generate("op", input("a"), readKey("a"));
    expect(cache.generate("op", input("a"), readKey("a"))).toBe(pending);
    expect(cache.inspect("op", "a").status).toBe("generating");
    const result = await pending;
    if (!result?.ok) throw new Error("Expected a generated profile");
    expect(result.value.path.pointAt(0)).toEqual([6, 0, 2]);
    expect(cache.inspect("op", "b").status).toBe("stale");
    expect(await cache.generate("op", input("a"), readKey("a"))).toEqual(result);
    expect(calls).toBe(1);
  });

  it("discards late success and late failure after an edit or deletion", async () => {
    const finish: ((value: typeof generated) => void)[] = [];
    const cache = new ToolpathCache(() => new Promise((resolve) => finish.push(resolve)));
    let key = "a";
    const old = cache.generate("op", input(key), async () => key);
    await Promise.resolve();
    key = "b";
    const current = cache.generate("op", input(key), async () => key);
    await Promise.resolve();
    finish[1]!(generated);
    await current;
    finish[0]!(generated);
    expect(await old).toBeUndefined();
    expect(cache.inspect("op", key).status).toBe("valid");

    const deleted = cache.generate("op", input("c"), readKey("c"));
    await Promise.resolve();
    cache.retain(new Set());
    finish[2]!({ ok: false, errors: ["Old failure"] });
    expect(await deleted).toBeUndefined();
    expect(cache.inspect("op", "c").status).toBe("missing");
  });

  it("discards an edited job without a replacement and permits a failed operation to retry", async () => {
    let key = "a";
    let calls = 0;
    const cache = new ToolpathCache(async () => {
      calls++;
      return calls < 3 ? { ok: false, errors: ["Generation failed"] } : generated;
    });
    const abandoned = cache.generate("op", input(key), async () => key);
    key = "b";
    expect(await abandoned).toBeUndefined();
    expect(cache.inspect("op", "a").status).toBe("missing");
    await cache.generate("op", input(key), async () => key);
    expect(cache.inspect("op", "b")).toEqual({ status: "failed", errors: ["Generation failed"] });
    await cache.generate("op", input(key), async () => key);
    expect(cache.inspect("op", "b").status).toBe("valid");
  });
});
