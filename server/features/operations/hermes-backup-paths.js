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
//   `SOUL.md`, `skills/`, `plugins/` and the routines (`cron/jobs.json`) with their
//   delivery record. Everything else of a home (session databases and transcripts,
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
  /^(config\.yaml|SOUL\.md|\.env|auth\.json|agentpier-routine-runs\.json|cron\/jobs\.json)$|^(skills|plugins)(\/|$)/;
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
