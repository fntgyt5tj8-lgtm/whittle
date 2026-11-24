import type { CamResult } from "@whittle/cam";
import { runToolpathJob, type GeneratedToolpath, type ToolpathJob } from "./toolpathJob";

type Result = CamResult<GeneratedToolpath>;

export class ToolpathWorkers {
  private idle: Worker[] = [];
  private ready = new WeakSet<Worker>();
  private active = 0;
  private queue: (() => Promise<void>)[] = [];
  private fallback = typeof Worker === "undefined";

  run(job: ToolpathJob, isCurrent: () => boolean): Promise<Result> {
    return new Promise((resolve) => {
      this.queue.push(async () => {
        try {
          resolve(isCurrent() ? await this.compute(job) : { ok: false, errors: ["Toolpath inputs changed."] });
        } catch (error) {
          resolve({ ok: false, errors: [error instanceof Error ? error.message : String(error)] });
        }
      });
      this.pump();
    });
  }

  private pump() {
    const limit = this.fallback ? 1 : Math.min(2, navigator.hardwareConcurrency || 1);
    while (this.active < limit && this.queue.length) {
      const run = this.queue.shift()!;
      this.active++;
      void run().finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async compute(job: ToolpathJob): Promise<Result> {
    if (!this.fallback) {
      try {
        return await this.runInWorker(job);
      } catch (error) {
        if (!(error instanceof WorkerUnavailable)) throw error;
        this.fallback = true;
        for (const worker of this.idle.splice(0)) worker.terminate();
      }
    }
    // Yield so the pending status can paint in browsers where workers are unavailable.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return runToolpathJob(job);
  }

  private runInWorker(job: ToolpathJob): Promise<Result> {
    let worker: Worker;
    try {
      worker = this.idle.pop() ?? new Worker(new URL("./toolpath.worker.ts", import.meta.url), {
        type: "module", name: "whittle-cam",
      });
    } catch {
      throw new WorkerUnavailable("The CAM worker could not start.");
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => fail(new Error("Toolpath generation timed out.")), 120_000);
      function fail(error: Error) {
        clearTimeout(timeout);
        worker.terminate();
        reject(error);
      }
      worker.onmessage = ({ data }: MessageEvent<Result | "ready">) => {
        if (data === "ready") {
          this.ready.add(worker);
          return;
        }
        clearTimeout(timeout);
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        if (this.fallback) worker.terminate();
        else this.idle.push(worker);
        resolve(data);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        fail(this.ready.has(worker) ? new Error("The CAM worker stopped unexpectedly.")
          : new WorkerUnavailable("The CAM worker could not start."));
      };
      worker.onmessageerror = () => fail(new Error("The CAM worker returned unreadable data."));
      try {
        worker.postMessage(job);
      } catch (error) {
        fail(new Error(String(error)));
      }
    });
  }
}

class WorkerUnavailable extends Error {}
