// The owner's workspace state: the body of GET /api/state and the value of the live
// `state` topic (live-state-topic.js). Sessions, accounts, connections, preferences
// and the inbox count are read each time. The detected CLIs (with their versions),
// the PATH utilities and the sessions left on a legacy tmux server change rarely and
// cost a PATH scan or a tmux call, so they come from a cache that lasts `slowMs` or
// until invalidateSlow(). Every read carries `readStartedAt`, a stamp that rises with
// each read started (also across a restart, as it follows the clock), so the browser
// can keep the newer of a pushed value and a REST answer.
import path from "node:path";
import { detectUtilities as detectPathUtilities } from "../accounts/account-store.js";
import { toolBinDirectories } from "../tools/tool-paths.js";
import { chromiumUtility } from "../tools/chromium-installer.js";
import { isManagedInstall, withCliVersions } from "../tools/cli-version.js";
import { SessionProjects } from "./session-projects.js";
import { publicSession } from "./session-public.js";
import { legacyTmuxSessions as listLegacyTmux } from "./legacy-tmux-server.js";

/**
 * `read({ fresh })` returns the current state (`fresh` detects the slow parts again);
 * `invalidateSlow()` makes the next read detect them again; `offerSessions(list,
 * listedAt)` hands over a session list just read elsewhere (the 2.5 s collect, with
 * the read stamp from before its listing), which the next read uses once instead of
 * listing the sessions again, if it starts within `offerMs`; that read is then dated
 * to the listing (`readStartedAt`, and `basedOn(listedAt)` for its live push). Services are read late, so a router may create this before every
 * service exists.
 */
export function createWorkspaceState(
  services,
  {
    slowMs = 60000,
    offerMs = 1000,
    now = Date.now,
    detectUtilities = detectPathUtilities,
    legacyTmuxSessions = listLegacyTmux,
  } = {},
) {
  const projects = new SessionProjects();
  let slow = null;
  let stamp = 0;
  let offered = null;
  // The offered list if it is fresh enough, else a new listing; `taken` is the offer.
  const takeOffer = () => {
    const taken = offered;
    offered = null;
    return taken && now() - taken.at <= offerMs ? taken : null;
  };
  // The inbox count rides on the state; a failed read never fails the state.
  const inboxSummary = async () => {
    try {
      return (await services.inbox?.summary()) ?? null;
    } catch {
      return null;
    }
  };
  const detect = async () => {
    const { config } = services;
    const [tools, legacy] = await Promise.all([
      // Never waits for a probe: a slow --version must not delay the app.
      withCliVersions(services.tools(), {
        managed: (tool) =>
          isManagedInstall(tool.id, tool.path, {
            home: config.home,
            dataDir: config.dataDir,
          }),
      }),
      legacyTmuxSessions(services.sessions).catch(() => []),
    ]);
    const utilities = detectUtilities(
      { ...process.env, HOME: config.home },
      true,
      toolBinDirectories(config.dataDir),
    );
    return { tools, utilities, legacy };
  };
  const slowParts = () => {
    if (slow && now() - slow.at < slowMs) return slow.value;
    const entry = { at: now(), value: detect() };
    slow = entry;
    const forget = () => {
      if (slow === entry) slow = null;
    };
    entry.value.then(
      // A version probe still running: read again, so its result shows at once.
      ({ tools }) => tools.some((tool) => tool.versionStatus === "checking") && forget(),
      forget,
    );
    return entry.value;
  };
  return {
    async read({ fresh = false, basedOn } = {}) {
      stamp = Math.max(now(), stamp + 1);
      let readStartedAt = stamp;
      if (fresh) slow = offered = null;
      const { config, sessions, activity, preferences } = services;
      const offer = takeOffer();
      // A reused list is as old as its listing: both stamps say so.
      if (offer && Number.isSafeInteger(offer.listedAt)) {
        readStartedAt = Math.min(readStartedAt, offer.listedAt);
        basedOn?.(offer.listedAt);
      }
      const [{ tools, utilities, legacy }, listed] = await Promise.all([
        slowParts(),
        (offer ? Promise.resolve(offer.list) : sessions.list()).then((list) =>
          activity.enrich(list),
        ),
      ]);
      return {
        tools,
        utilities: [
          ...utilities,
          // The managed agent browser, which only AgentPier installs.
          ...(config.dataDir ? [chromiumUtility(path.join(config.dataDir, "clis"))] : []),
          // The managed REA tool (rea-tool.js); absent without the MCP server store.
          ...(services.rea ? [services.rea.utility()] : []),
        ],
        accounts: services.accounts.list(),
        sharedCliExtensions: true,
        providerConnections: services.providerConnections.list(),
        // Never the SSH agent's token or binary paths (session-public.js).
        sessions: (await projects.enrich(listed)).map(publicSession),
        inbox: await inboxSummary(),
        // Sessions still on the tmux server of a release from before the rename.
        legacyTmux: { sessions: legacy },
        // With registered push devices, open pages report what they show (quiet while
        // visible, server/features/notifications/push-presence.js).
        pushDevices: services.notifications?.deviceCount?.() ?? 0,
        home: config.home,
        ...preferences.get(),
        remoteUrl: config.remoteUrl || null,
        readStartedAt,
      };
    },
    invalidateSlow() {
      slow = null;
    },
    offerSessions(list, listedAt) {
      if (Array.isArray(list)) offered = { list: [...list], at: now(), listedAt };
    },
  };
}

/** The state without its read stamp: what a change is measured on. */
export const withoutReadStamp = (value) => {
  if (!value || typeof value !== "object") return value;
  const { readStartedAt: _stamp, ...rest } = value;
  return rest;
};

/** The services' one workspace state, made on first use. */
export const workspaceStateOf = (services) =>
  (services.workspaceState ??= createWorkspaceState(services));
