// The live tool job topics, owner only, kinds of the `job.<kind>` family
// (live/job-topics.js):
//
// `job.tool:<tool>` is one tool's installation, the value
// GET /tool-installations?tool=<tool> answers (its entry and the installer's `busy`).
// `job.chromium:current` is the managed agent browser's installation, the same value
// for `chromium`, which the agent browser settings follow. The installer runs one job
// at a time and every write of it (start, progress, end, removal, busy cleared)
// calls its onChange, so every tool's topic is signaled (`busy` is shared). All its
// writes happen in this process: neither topic is sampled. A list read while a CLI's
// version was still being probed (`versionStatus: "checking"`) signals again once
// the probe has its answer.
//
// `job.rea:current` is the managed REA tool, the value GET /rea answers. ReaTool's
// onChange signals the start, every step and the end of a job; Core's package
// install, which the job waits for, changes the state without telling REA, so a
// running job is also sampled every second (the former poll).
import { assistantProblem } from "../assistants/assistant-validation.js";
import { defineJobTopic } from "../live/job-topics.js";
import { toolInstallations, versionsSettled } from "./tool-installation-list.js";

export const REA_JOB_SAMPLE_MS = 1000;

// The catalog's tool ids (tool-installer.js); an unknown one is the route's 404.
const TOOL_ID = /[a-z][a-z0-9-]{0,39}/;
const CURRENT = /current/;

/** The installer changed: signals every tool's job topic on `hub` (services.live). */
export function toolJobsChanged(hub) {
  hub?.invalidate("job.tool");
  hub?.invalidate("job.chromium");
}

/** REA's job state changed: signals its topic on `hub` (services.live). */
export function reaJobChanged(hub) {
  hub?.invalidate("job.rea");
}

/** Registers `job.tool`, `job.chromium` and `job.rea` on `hub`. */
export function defineToolJobTopics(hub, services) {
  // A CLI's version may still be probed (`checking`): its result signals again.
  const readTool = async (tool) => {
    const value = await toolInstallations(services.installer, tool);
    if (value.installations.some((item) => item.versionStatus === "checking"))
      versionsSettled(services.installer).then(
        () => toolJobsChanged(hub),
        () => {},
      );
    return value;
  };
  defineJobTopic(hub, { kind: "tool", param: TOOL_ID, read: readTool });
  defineJobTopic(hub, {
    kind: "chromium",
    param: CURRENT,
    read: () => readTool("chromium"),
  });
  defineJobTopic(hub, {
    kind: "rea",
    param: CURRENT,
    sampleMs: REA_JOB_SAMPLE_MS,
    status: (value) => value.status,
    read: () => {
      // Without the MCP server store there is no REA, as GET /rea answers (503).
      if (!services.rea)
        throw Object.assign(assistantProblem("unavailable", 503), { expected: true });
      return services.rea.state();
    },
  });
}
