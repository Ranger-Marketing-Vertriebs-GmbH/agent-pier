// What GET /api/assistant-runtime answers and the agent list feed carries: the
// runtime status with the write guard diagnostic and whether agents can drive a browser.
import { chromiumUnavailable } from "../tools/chromium-installer.js";
import { runtimeStatus } from "./team-bridge.js";

/** The runtime view of `runtime` for the AssistantService `assistants`. */
export function runtimeView({ runtime, assistants, bridge, webTools }) {
  return {
    ...runtimeStatus(runtime, assistants, bridge),
    // Whether the agents can drive a browser; the settings page gates its switch on it.
    browser: browserStatus(webTools),
  };
}

export function browserStatus(webTools) {
  // Whether AgentPier can install its own agent browser on this host.
  const installable = !chromiumUnavailable(process.platform, process.arch);
  try {
    const { available, name, visible, managed } = webTools?.detect() || {};
    // Whether agents may get a visible window, and why not ("noApp", "noDisplay").
    const window = visible?.available
      ? { available: true }
      : { available: false, reason: visible?.reason || "noApp" };
    // A browser installed (or removed) since the running Gateway started needs a
    // restart before agents drive it.
    let restartNeeded = false;
    try {
      restartNeeded = !!webTools?.differs?.();
    } catch {
      /* No running Gateway to compare with. */
    }
    return {
      ...(available ? { available: true, name } : { available: false }),
      visible: window,
      managed: !!managed,
      installable,
      restartNeeded,
    };
  } catch {
    return {
      available: false,
      visible: { available: false, reason: "noApp" },
      managed: false,
      installable,
      restartNeeded: false,
    };
  }
}
