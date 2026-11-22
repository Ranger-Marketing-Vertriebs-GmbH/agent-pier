// What host backups make of AgentPier's private Hermes folder, `assistants/hermes/`
// (runtimes/hermes/hermes-paths.js): one folder per agent below `home` (its HOME),
// `state` (its HERMES_HOME) and `workspaces` (its work folder, a fallback beside the
// shared workspaces/), plus `runtimes`, `logs`, `tmp` and the installation's own
// records. Every path here is relative to assistants/.
//
// - Never archived: the installations, logs, scratch and uv's cache, the runtime
//   selection (it names this host's runtimes/ by absolute path; a restored instance
//   installs the pinned release again), and what a running gateway keeps only for
//   itself in a home: its processes' state, heartbeats, logs, caches, Hermes's own
//   backups (copies of .env) and the team bridge's per-start address and token.
// - Credentials (backup-credentials.js isCredentialFile): each home's `.env` (model,
//   MCP, bot and speech keys) and `auth.json` travel only sealed, as OpenClaw's do.
// - Public, so a restore brings back working agents: each home's `config.yaml`,
//   `SOUL.md`, `skills/`, `plugins/` and the routines (`cron/jobs.json`, AgentPier's
//   part of them in `agentpier-routines.json`) with their delivery record. Everything else of a home (session databases and transcripts,
//   memories, pairing and platform state, run output) and the agents' HOME and work
//   folders are private content: sealed with the histories, or left out.
// - The agents' browser profiles (`home/<id>/agentpier-browser/`) go only sealed, as
//   OpenClaw's (browser-profile-backup.js).

const top = /^hermes\/(runtimes|logs|tmp|uv-cache)(\/|$)/;
const rootFiles = /^hermes\/(runtime|candidate|update)\.json$|^hermes\/[^/]+\.lock$/;
// Inside one agent's HERMES_HOME.
const home = /^hermes\/state\/[^/]+\/(.+)$/;
const runtimeOnly =
  /^(logs|cache|runtime|state|backups|installs|plugin-update-checks|source-checks|audio_cache|image_cache|sandboxes|desktop)(\/|$)|^(gateway_state\.json|gateway-starts\.log|install_id)$|\.heartbeat$|^plugins\/agentpier-team\/bridge\.json$/;
const publicHome =
  /^(config\.yaml|SOUL\.md|\.env|auth\.json|agentpier-routine-runs\.json|agentpier-routines\.json|cron\/jobs\.json)$|^(skills|plugins)(\/|$)/;
// A folder below the home that holds public files: walked, never private as a whole.
const publicFolder = /^(skills|plugins)(\/.*)?$|^cron$/;
const browser = /^hermes\/home\/[^/]+\/agentpier-browser(\/|$)/;
// The gateway's host-wide lock files in an agent's HOME.
const homeLocks = /^hermes\/home\/[^/]+\/\.local\/state\/hermes(\/|$)/;

/** Whether `relative` is Hermes data no host backup archives. */
export const isHermesExcluded = (relative) => {
  if (top.test(relative) || rootFiles.test(relative) || homeLocks.test(relative))
    return true;
  const inside = home.exec(relative)?.[1];
  return inside !== undefined && runtimeOnly.test(inside);
};

/** Whether `relative` is (in) an agent browser profile of Hermes's, archived sealed only. */
export const isHermesBrowserTree = (relative) => browser.test(relative);

/**
 * Whether `relative` is or lies in a private Hermes folder: an agent's HOME and work
 * folder, and every entry of its HERMES_HOME that is no public file or folder.
 */
export function isPrivateHermesTree(relative) {
  if (/^hermes\/(home|workspaces)\/[^/]+(\/|$)/.test(relative)) return true;
  const inside = home.exec(relative)?.[1];
  return inside !== undefined && !publicHome.test(inside) && !publicFolder.test(inside);
}

// An agent's HERMES_HOME: its .env holds the model, MCP, bot and speech keys,
// auth.json Hermes's own provider logins.
const credential = /^hermes\/state\/[^/]+\/(\.env|auth\.json)$/;
// The same below Hermes's own folder, as its update journal snapshots it
// (hermes-paths.js state/<agent>/): the .env and every copy of it, auth.json, and
// Hermes's own backups of the home, which hold .env copies.
const snapshotCredential = /^state\/[^/]+\/(\.env(\.[^/]*)?|auth\.json|backups\/.+)$/;

// The browser profile AgentPier runs for a Hermes agent lives in the agent's HOME,
// named by its runtime agent id (hermes-browser.js). Paths relative to the data
// directory, as the sealed capture names its members (browser-profile-backup.js).
const browserProfiles = Object.freeze({
  // The folder the agents' homes lie in, and the member prefix of their files.
  prefix: "assistants/hermes/home",
  // The profile's folder in a home; its files lie below `user-data`.
  folder: "agentpier-browser",
  /** The home's name for the agent with the stored id `id`, or null for no folder name. */
  homeOf: (id) => (/^ap-[A-Za-z0-9-]{1,100}$/.test(`ap-${id}`) ? `ap-${id}` : null),
  /** Whether member `name` is a file of such a profile. */
  member: (name) =>
    /^assistants\/hermes\/home\/ap-[A-Za-z0-9-]{1,100}\/agentpier-browser\/user-data\/.+$/.test(
      name,
    ),
});

/** What host backups ask of a runtime's private folder (../runtime-backup-paths.js). */
export const hermesBackupPaths = Object.freeze({
  excluded: isHermesExcluded,
  browserTree: isHermesBrowserTree,
  privateTree: isPrivateHermesTree,
  credential: (relative) => credential.test(relative),
  snapshotCredential: (relative) => snapshotCredential.test(relative),
  browserProfiles,
});
