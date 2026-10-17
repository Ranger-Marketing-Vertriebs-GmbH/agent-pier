import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const macApps = (home, apps) =>
  apps.flatMap(([name, app]) => [
    [name, path.join("/Applications", app)],
    [name, path.join(home, "Applications", app)],
  ]);
const candidates = {
  darwin: (home) =>
    macApps(home, [
      ["Chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["Brave", "Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["Edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      ["Chromium", "Chromium.app/Contents/MacOS/Chromium"],
    ]),
  linux: () => [
    ["Chrome", "/usr/bin/google-chrome"],
    ["Chrome", "/usr/bin/google-chrome-stable"],
    ["Brave", "/usr/bin/brave-browser"],
    ["Edge", "/usr/bin/microsoft-edge"],
    ["Chromium", "/usr/bin/chromium"],
    // Snap Chromium (/snap/bin/chromium, and the /usr/bin/chromium-browser wrapper
    // Ubuntu ships for it) is confined and cannot be driven with an isolated profile.
  ],
};
// A browser app of its own for the agents' visible windows: never the owner's daily
// Chrome, so the agents' windows, Dock icon and Space stay apart from the owner's.
const agentCandidates = {
  darwin: (home) =>
    macApps(home, [
      ["Brave", "Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["Chromium", "Chromium.app/Contents/MacOS/Chromium"],
      [
        "Chrome for Testing",
        "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ],
    ]),
  linux: () => [
    ["Brave", "/usr/bin/brave-browser"],
    ["Brave", "/opt/brave.com/brave/brave"],
    ["Chromium", "/usr/bin/chromium"],
  ],
};

/** Whether a visible window can open: macOS always, Linux with X11 or Wayland. */
export function hasDisplay(platform = process.platform, env = process.env) {
  if (platform === "darwin") return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * AgentPier installs no browser; OpenClaw drives an installed one with its own
 * isolated profiles. The Gateway runs with a private HOME, so the path is explicit.
 * A separate agent app (Brave, Chromium, Chrome for Testing) is preferred for every
 * agent profile, so one profile is always opened by the same app. `visible` says
 * whether agents may get a visible window: only with that separate app and a
 * display; otherwise `reason` is "noApp" or "noDisplay".
 */
export function detectBrowser({
  platform = process.platform,
  exists = fs.existsSync,
  home = os.homedir(),
  env = process.env,
} = {}) {
  const first = (list) =>
    (list[platform]?.(home) || []).find(([, executablePath]) => exists(executablePath));
  const agent = first(agentCandidates);
  const any = agent || first(candidates);
  if (!any) return { available: false, visible: { available: false, reason: "noApp" } };
  const [name, executablePath] = any;
  const visible = !agent
    ? { available: false, reason: "noApp" }
    : hasDisplay(platform, env)
      ? { available: true }
      : { available: false, reason: "noDisplay" };
  return { available: true, name, executablePath, visible };
}
