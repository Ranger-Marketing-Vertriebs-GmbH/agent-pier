import { managedChromium } from "../tools/chromium-installer.js";
import { browserCandidates, detectBrowser } from "./browser-detection.js";
import { BrowserLaunchCheck } from "./browser-launch-check.js";

/**
 * The agents' browser app for the assistant graph: `detect()` chooses it, the managed
 * Chrome for Testing below `root` (<dataDir>/clis) first, and passes over an app the
 * launch check found not starting (Linux); `prepare()` runs that check before a start.
 */
export function agentBrowserDetection(root, check = new BrowserLaunchCheck()) {
  const managed = () => managedChromium(root)?.executable;
  return {
    detect: () =>
      detectBrowser({ managed: managed(), launch: (path) => check.result(path) }),
    prepare: () => check.prepare(browserCandidates({ managed: managed() })),
  };
}
