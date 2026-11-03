import { memoryEnabled } from "./native-capabilities.js";
import { NativeMemory, corpusFolder } from "./native-memory.js";
import { leadMirrorDir } from "./member-memory.js";
import { parseReview } from "./memory-review-answer.js";
import { reviewInput, reviewInstructions } from "./memory-review-prompt.js";
import { runtimeFor, runtimeIdOf } from "./runtimes/runtime-for.js";
import { memoryReviewInputLimit } from "./team-plugin/memory-review.js";

/**
 * The memory review after a model switch with fresh chats (model-switch.js): the
 * agent's new model reads the agent's memory in one call outside any session and
 * chat history (sessions.reviewMemory, agent-runtime.js) and names the entries that
 * only record a model's own refusals or limits. Nothing is written here; the owner
 * decides (onReviewResults).
 */

// The most input one review sends, file headers included, within the plugin's
// limit. MEMORY.md and USER.md go first, then the notes newest first; a file that
// does not fit whole stays out and the review says `truncated`.
export const reviewBudget = Math.min(60000, memoryReviewInputLimit);
const rootFiles = ["MEMORY.md", "USER.md"];
// The room a file takes in the input besides its text (reviewInput).
const framing = (name) => `=== ${name}\n\n\n`.length;

// A note of the agent's own: not the Dream Diary, the lead's mirrored memory
// (reviewed with the lead) or dreaming's corpus.
const ownNote = (note) =>
  !note.diary &&
  !note.name.startsWith(`${leadMirrorDir}/`) &&
  !corpusFolder.test(note.name);

const failed = (reason) => ({ status: "failed", reason, entries: [] });

export class MemoryReview {
  constructor({ service }) {
    this.service = service;
    this.memory = service.nativeMemory ?? new NativeMemory(service);
  }

  /**
   * Reviews the memory of agent `assistantId`: `{ status, entries, dropped,
   * truncated }`. `status` "found" when `entries` (each `{ file, entry, kind:
   * "model-limit", recommendation }`, memory-review-answer.js) name entries to
   * decide, "none" when there are none or no memory to read, "failed" (with
   * `reason`) when the model answered unreadably twice or could not be asked.
   * `dropped` counts the answer's items that named no entry. Never throws.
   */
  async run(assistantId) {
    try {
      const agent = this.service.store.getAssistant(assistantId);
      if (!memoryEnabled(agent))
        return { status: "none", entries: [], dropped: 0, truncated: false };
      const { files, truncated } = await this.files(agent);
      if (!files.length) return { status: "none", entries: [], dropped: 0, truncated };
      const sessions = runtimeFor(agent, this.service.runtime).sessions;
      const request = {
        agentId: agent.runtimeAgentId,
        instructions: reviewInstructions,
        input: reviewInput(files),
      };
      const ask = async () =>
        parseReview(
          (await sessions.reviewMemory(request))?.text,
          files,
          runtimeIdOf(agent),
        );
      // A refusal or a broken answer is asked once more.
      const review = (await ask()) ?? (await ask());
      if (!review) return { ...failed("unreadable"), truncated };
      const entries = review.entries.filter((e) => e.kind === "model-limit");
      return {
        status: entries.length ? "found" : "none",
        entries,
        dropped: review.dropped,
        truncated,
      };
    } catch (error) {
      // Codes only: an error never carries memory text into the log.
      console.error("Memory review failed:", error?.code || "UNAVAILABLE");
      return failed("unavailable");
    }
  }

  // The memory files with text, as much as the budget holds: `{ files, truncated }`.
  // Hermes keeps its memory in MEMORY.md and USER.md alone.
  async files(agent) {
    const files = [];
    let left = reviewBudget;
    let truncated = false;
    const add = (name, content) => {
      if (!content.trim()) return;
      const size = content.length + framing(name);
      if (size > left) truncated = true;
      else {
        files.push({ name, content });
        left -= size;
      }
    };
    for (const name of rootFiles)
      add(name, (await this.memory.read(agent.id, name)).content);
    if (runtimeIdOf(agent) === "hermes") return { files, truncated };
    for (const note of await this.notes(agent)) {
      // A UTF-8 byte is at most one character: a note far beyond the room is not read.
      if (note.size / 3 > left) {
        truncated = true;
        continue;
      }
      try {
        add(note.name, (await this.memory.read(agent.id, note.name)).content);
      } catch {
        truncated = true; // Gone meanwhile, or over the note read limit.
      }
    }
    return { files, truncated };
  }

  // The agent's own notes under memory/, newest first, every page.
  async notes(agent) {
    const notes = [];
    for (let offset = 0; offset !== null;) {
      const page = await this.memory.files(agent.id, { offset });
      notes.push(...page.files.filter(ownNote));
      offset = page.nextOffset;
    }
    return notes;
  }
}

// The reviews under way per service, for memoryReviewsSettled.
const running = new WeakMap();

/** Whether agent `assistantId` has memory to review (its memory capability). */
export function reviewsMemory(service, assistantId) {
  try {
    return memoryEnabled(service.store.getAssistant(assistantId));
  } catch {
    return false;
  }
}

/**
 * Starts the reviews of a switch `plan` (model-switch.js planSwitch) with fresh
 * chats, one per agent of the plan with memory, without waiting for them: the
 * model may take minutes. Their results, `[{ assistantId, ...run() }]`, go to
 * onReviewResults together, so one switch makes one decision for the owner. Returns
 * the promise of those results, or null when nothing is reviewed.
 */
export function startMemoryReviews(service, plan) {
  if (!plan?.fresh) return null;
  const ids = plan.agents.filter((id) => reviewsMemory(service, id));
  if (!ids.length) return null;
  const review = new MemoryReview({ service });
  let set = running.get(service);
  if (!set) running.set(service, (set = new Set()));
  const done = Promise.all(
    ids.map(async (assistantId) => ({ assistantId, ...(await review.run(assistantId)) })),
  )
    .then(async (reviews) => {
      await onReviewResults(service, plan, reviews);
      return reviews;
    })
    .catch((error) => {
      // The code only: the results hold entry text.
      console.error(
        "Memory review results were not handed on:",
        error?.code ?? error?.name,
      );
      return [];
    })
    .finally(() => set.delete(done));
  set.add(done);
  return done;
}

/** The results of the reviews under way for `service`, once they are settled. */
export const memoryReviewsSettled = (service) =>
  Promise.all([...(running.get(service) || [])]);

/**
 * Where the results of one switch's reviews go (`reviews` as startMemoryReviews
 * names them): the owner's decision. For now nothing happens with them.
 */
export async function onReviewResults() {}
