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
  // Google Chrome first: its package installs the setuid sandbox helper and an
  // AppArmor profile, so it starts where Ubuntu 23.10+ restricts user namespaces.
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
 * The installed browser apps in their order of preference: the managed Chrome for
 * Testing, the separate agent apps, then any other Chromium-based browser. Each entry
 * is `{ name, executablePath, agent, managed }`; an app appears once.
 */
function installed({ platform, exists, home, managed }) {
  const found = (list, agent) =>
    (list[platform]?.(home) || [])
      .filter(([, executablePath]) => exists(executablePath))
      .map(([name, executablePath]) => ({ name, executablePath, agent }));
  const all = [
    ...(managed && exists(managed)
      ? [
          {
            name: "Chrome for Testing",
            executablePath: managed,
            agent: true,
            managed: true,
          },
        ]
      : []),
    ...found(agentCandidates, true),
    ...found(candidates, false),
  ];
  return all.filter(
    (entry, index) =>
      all.findIndex((other) => other.executablePath === entry.executablePath) === index,
  );
}

/** The executables detectBrowser chooses from, in its order (for the launch check). */
export function browserCandidates({
  platform = process.platform,
  exists = fs.existsSync,
  home = os.homedir(),
  managed = null,
} = {}) {
  return installed({ platform, exists, home, managed }).map((e) => e.executablePath);
}

/**
 * AgentPier installs no browser; OpenClaw drives an installed one with its own
 * isolated profiles. The Gateway runs with a private HOME, so the path is explicit.
 * A separate agent app (Brave, Chromium, Chrome for Testing) is preferred for every
 * agent profile, so one profile is always opened by the same app. `visible` says
 * whether agents may get a visible window: only with that separate app and a
 * display; otherwise `reason` is "noApp" or "noDisplay".
 *
 * `launch(executablePath)` answers what the launch check knows of an app
 * (browser-launch-check.js): an app known not to start is passed over for the next
 * one. `launch` then names the first such app and its problem, with `usable: false`
 * when no app starts (the first one stays chosen, so its error reaches the agent).
 */
export function detectBrowser({
  platform = process.platform,
  exists = fs.existsSync,
  home = os.homedir(),
  env = process.env,
  // The managed Chrome for Testing AgentPier installed (chromium-installer.js); it
  // comes first, being the agents' own app by construction.
  managed = null,
  launch = () => undefined,
} = {}) {
  const all = installed({ platform, exists, home, managed });
  if (!all.length)
    return { available: false, visible: { available: false, reason: "noApp" } };
  const problemOf = (entry) => {
    const known = launch(entry.executablePath);
    return known?.ok === false ? known.problem || "crashed" : null;
  };
  const starting = all.find((entry) => !problemOf(entry));
  const chosen = starting || all[0];
  // The first app passed over (or the chosen one, when none starts).
  const failed = all.slice(0, all.indexOf(chosen) + 1).find(problemOf);
  const { name, executablePath } = chosen;
  const visible = !chosen.agent
    ? { available: false, reason: "noApp" }
    : hasDisplay(platform, env)
      ? { available: true }
      : { available: false, reason: "noDisplay" };
  return {
    available: true,
    name,
    executablePath,
    visible,
    ...(chosen.managed && { managed: true }),
    ...(failed && {
      launch: { name: failed.name, problem: problemOf(failed), usable: !!starting },
    }),
  };
}
