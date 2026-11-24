import { runToolpathJob, type ToolpathJob } from "./toolpathJob";

self.onmessage = ({ data }: MessageEvent<ToolpathJob>) => {
  try {
    self.postMessage(runToolpathJob(data));
  } catch (error) {
    self.postMessage({ ok: false, errors: [String(error)] });
  }
};

self.postMessage("ready");
