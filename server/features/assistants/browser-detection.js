import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const candidates = {
  darwin: (home) =>
    [
      ["Chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["Brave", "Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["Edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      ["Chromium", "Chromium.app/Contents/MacOS/Chromium"],
    ].flatMap(([name, app]) => [
      [name, path.join("/Applications", app)],
      [name, path.join(home, "Applications", app)],
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

// AgentPier installs no browser; OpenClaw drives an installed one with its own
// isolated profile. The Gateway runs with a private HOME, so the path is explicit.
export function detectBrowser({
  platform = process.platform,
  exists = fs.existsSync,
  home = os.homedir(),
} = {}) {
  for (const [name, executablePath] of candidates[platform]?.(home) || [])
    if (exists(executablePath)) return { available: true, name, executablePath };
  return { available: false };
}
