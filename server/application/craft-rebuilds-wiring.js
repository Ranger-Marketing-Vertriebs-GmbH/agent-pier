import { CraftRebuilds } from "../features/craft/craft-rebuilds.js";
import { craftRebuildsChanged } from "../features/craft/live-topics.js";
import { ownerQuestions, questionNotice } from "../features/craft/rebuild-questions.js";
import { logCraftFailure } from "../features/craft/craft-log.js";

/**
 * The Craft Anything rebuild supervisor over the managed tool (`services.craft`), or
 * null without it. Its changes reach the live topics on `services.live`, read late:
 * the hub exists only once the server listens. A question that opens reaches the
 * inbox and, once, a push. Restored in app.js once the server listens (not after the
 * tool starts), closed in
 * shutdown.js.
 */
export function createCraftRebuilds(services) {
  const { config, craft, accounts, preferences, memory } = services;
  if (!craft) return null;
  const rebuilds = new CraftRebuilds({
    dataDir: config.dataDir,
    craft,
    accounts,
    preferences,
    memory,
  });
  const questions = new RebuildQuestionWatch({
    rebuilds,
    opened: (view, question) =>
      services.notifications?.notify(questionNotice(view, question)),
    changed: () => services.inbox?.changed(),
  });
  rebuilds.onChange((event) => {
    craftRebuildsChanged(services.live, event);
    questions.update(event);
  });
  return rebuilds;
}

/**
 * Follows the owner's open questions (rebuild-questions.js) across CraftRebuilds'
 * changes (`{ id }` or `{ list }`): `opened(view, question)` once for each question
 * that newly opens, `changed()` when the open questions or their titles (what the
 * inbox lists) changed. A sample that only moves the build on announces nothing. Questions already open when it starts (a
 * restart) count as seen; a question is forgotten once it closes.
 */
export class RebuildQuestionWatch {
  constructor({ rebuilds, opened, changed }) {
    Object.assign(this, { rebuilds, opened, changed });
    this.open = new Map();
    for (const view of rebuilds.list()) this.remember(view.id, ownerQuestions(view));
  }

  remember(id, questions) {
    // Each open question's id with its title.
    const titles = new Map(questions.map((question) => [question.id, question.title]));
    if (titles.size) this.open.set(id, titles);
    else this.open.delete(id);
  }

  update(event = {}) {
    const one = typeof event.id === "string";
    const views = one
      ? [[event.id, this.rebuilds.get(event.id)]]
      : this.rebuilds.list().map((view) => [view.id, view]);
    let changed = false;
    if (!one) {
      const present = new Set(views.map(([id]) => id));
      for (const id of this.open.keys())
        if (!present.has(id)) {
          this.open.delete(id);
          changed = true;
        }
    }
    for (const [id, view] of views) {
      const before = this.open.get(id) ?? new Map();
      const questions = ownerQuestions(view);
      for (const question of questions)
        if (!before.has(question.id)) {
          changed = true;
          this.announce(view, question);
        } else if (before.get(question.id) !== question.title) changed = true;
      if (questions.length !== before.size) changed = true;
      this.remember(id, questions);
    }
    if (changed) this.changed();
  }

  announce(view, question) {
    try {
      Promise.resolve(this.opened(view, question)).catch((error) =>
        logCraftFailure("announce a rebuild question", error),
      );
    } catch (error) {
      logCraftFailure("announce a rebuild question", error);
    }
  }
}
