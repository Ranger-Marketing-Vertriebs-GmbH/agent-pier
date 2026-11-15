import { PendingRestart } from "../features/assistants/pending-restart.js";
import {
  OfflineCommands,
  stateOwned,
} from "../features/assistants/runtimes/openclaw/offline-commands.js";
import {
  forgetDreamingSession,
  sweepNear,
} from "../features/assistants/dreaming-backups.js";
import { temporaryMember } from "../features/assistants/team-presentation.js";

/**
 * The pending restart (pending-restart.js) and OpenClaw's offline-only CLI commands
 * (offline-commands.js) as the assistant graph wires them: queued forgets ask for the
 * pending restart, which waits until no agent is busy and interrupts every agent, or
 * runs at once (as "Restart now") after 15 minutes or before dreaming's sweep; no
 * window starts while maintenance, a restart or an update runs. The supervisor's
 * beforeSpawn drains the queue at every Gateway start.
 */
export function restartWiring(assistants, synchronization, runtime) {
  assistants.pendingRestart = synchronization.pending = new PendingRestart({
    assistants,
    synchronization,
  });
  const affected = () => {
    const profiles = assistants.store.listAssistants();
    return {
      agents: profiles
        .filter((p) => !temporaryMember(p))
        .map(({ id, name }) => ({ id, name })),
      teamMembers: profiles.filter(temporaryMember).length,
    };
  };
  assistants.offlineCommands = new OfflineCommands({
    supervisor: runtime,
    async forget({ agent, sessions }) {
      let ran;
      try {
        ran = await forgetDreamingSession(
          assistants,
          { runtimeAgentId: agent },
          sessions,
        );
      } catch (error) {
        // A Gateway that still owns the state: the queue repeats it shortly.
        throw Object.assign(error, { stateOwned: stateOwned(error?.stderr) });
      }
      if (!ran)
        throw Object.assign(new Error("No runtime installed."), {
          code: "RUNTIME_UNAVAILABLE",
        });
    },
    request: (reason) => !!assistants.pendingRestart?.request(reason, affected()),
    force() {
      const pending = assistants.pendingRestart;
      pending?.request("memoryForget", affected());
      return pending?.restartNow();
    },
    urgent: () => sweepNear(new Date(), assistants.dreaming?.settings?.get()),
    busy: () =>
      !!(
        assistants.maintenance ||
        synchronization.changing ||
        synchronization.pending?.running ||
        synchronization.isUpdating()
      ),
  });
}
