// The live `job.ssh-tools:<sessionId>` topic, owner only, a kind of the `job.<kind>`
// family (live/job-topics.js): the SSH hosts of a session and the state of its SSH
// tools, the value GET /sessions/:id/ssh-accesses answers. While the tools start
// (`tools.state: "starting"`), the SSH MCP server the CLI spawned writes its readiness
// to a file the server does not hear, so a starting session is sampled every 1.5 s
// (the dialog's former poll); a ready, unavailable or reload-required one is not.
// SshSessions signals every change of a session's assignments. An unknown session is
// the route's 404.
import { SESSION_PARAM } from "../requests/live-topics.js";
import { sessionSshAccesses } from "./session-accesses.js";

export const SSH_TOOLS_SAMPLE_MS = 1500;

/** The assignments of `sessionId` (null: of every session) changed. */
export function sshToolsChanged(hub, sessionId) {
  if (typeof sessionId === "string") hub?.invalidate("job.ssh-tools", sessionId);
  else hub?.invalidate("job.ssh-tools");
}

/** The `job.ssh-tools` options for defineJobTopic (live/job-topics.js). */
export function sshToolsJob(services) {
  return {
    kind: "ssh-tools",
    param: SESSION_PARAM,
    sampleMs: SSH_TOOLS_SAMPLE_MS,
    // A starting server is the job that runs; every other state has ended.
    status: (value) => (value?.tools?.state === "starting" ? "running" : "ended"),
    read: async (id) => sessionSshAccesses(services, await services.sessions.get(id)),
  };
}
