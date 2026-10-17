import { memoryRedaction } from "./assistant-action-store.js";

/**
 * Links the agent workflows to the owner's memory forget (memory-forget.js):
 * forgetting an entry redacts the approved writes that stored it and their channel
 * notices, including entries forgotten while the agent services were not running.
 */
export class AssistantMemoryForget {
  constructor(workflows) {
    this.w = workflows;
    this.memory = workflows.s.memory;
    if (!this.memory) return;
    this.hook = () =>
      this.notices(workflows.store.redactMemoryWrites(this.memory.forgottenEntryIds()));
    this.memory.onForget = this.hook;
    // Logs a failure itself and keeps the marker for the next start or forget.
    this.memory.retryPurge?.();
  }
  /** Clears channel notices that quoted forgotten memory text. */
  notices(actionIds) {
    if (actionIds.length) this.w.s.assistantChannels?.outbox?.redactActions(actionIds);
  }
  /** 422: the text was forgotten in this project; the action keeps no copy either. */
  refusal(action, error) {
    return action.payload.action === "memory_write" && error.status === 422
      ? memoryRedaction(action.payload)
      : {};
  }
  /** Redacts the notices of an action refused as forgotten text. */
  refused(action) {
    if (action.diagnostic !== "MEMORY_FORGOTTEN") return;
    try {
      this.notices([action.id]);
    } catch {
      // The next forget or start redacts it with every other copy.
    }
  }
  close() {
    if (this.hook && this.memory.onForget === this.hook) this.memory.onForget = null;
  }
}
