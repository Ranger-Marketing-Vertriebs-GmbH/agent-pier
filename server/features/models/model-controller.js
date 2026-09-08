import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { parseModelPicker, currentModel, modelPromptReady } from "./model-parser.js";
export { parseModelPicker, currentModel, modelPromptReady } from "./model-parser.js";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sameOption = (a, b) =>
  a && b && a.label === b.label && a.description === b.description;

/** A control bridge to the existing native picker, never a second model process. */
export class ModelController {
  constructor({ sessions, timeout = 2200 }) {
    this.sessions = sessions;
    this.timeout = timeout;
    this.known = new Map();
    this.pending = new Set();
  }
  state(id, tool, raw) {
    const menu = parseModelPicker(tool, raw);
    const live = menu?.currentModel || (!menu ? currentModel(tool, raw) : null);
    if (live) this.known.set(id, live);
    if (menu) this.pending.add(id);
    else if (modelPromptReady(tool, raw)) this.pending.delete(id);
    return {
      currentModel: live || this.known.get(id) || null,
      currentSource: live ? "cli" : this.known.has(id) ? "confirmed" : null,
      picker: menu
        ? {
            token: menu.signature,
            title: menu.title,
            kind: menu.kind,
            options: menu.options,
            selected: menu.selected,
            searchable: menu.searchable,
          }
        : null,
      pending: !!menu || this.pending.has(id),
      notice:
        this.pending.has(id) && !menu
          ? serverMessages.models.additionalSelectionPending
          : null,
    };
  }
  assertModelChangeAllowed(session) {
    if (session.provider?.modelChangeRequiresRestart) {
      throw problem(
        "This provider configures context at startup. Select the model in the account settings and start a new session.",
        409,
      );
    }
  }
  read(id) {
    return this.sessions.control(
      id,
      async (tx) => {
        const state = this.state(id, tx.session.tool, await tx.screen());
        if (!tx.session.provider) return state;
        return {
          ...state,
          configuration: tx.session.provider,
          modelChangeRequiresRestart:
            tx.session.provider.modelChangeRequiresRestart === true,
        };
      },
      { allowStopped: true },
    );
  }
  async wait(tx, accept) {
    const end = Date.now() + this.timeout;
    let raw,
      previous,
      stable = 0;
    do {
      await sleep(50);
      raw = await tx.screen();
      const menu = parseModelPicker(tx.session.tool, raw);
      if (accept(menu, raw)) {
        stable = raw === previous ? stable + 1 : 0;
        if (stable >= 2) return raw;
      } else stable = 0;
      previous = raw;
    } while (Date.now() < end);
    return raw;
  }
  open(id) {
    return this.sessions.control(id, async (tx) => {
      this.assertModelChangeAllowed(tx.session);
      const tool = tx.session.tool;
      const raw = await tx.screen();
      const menu = parseModelPicker(tool, raw);
      if (menu) return this.state(id, tool, raw);
      if (!modelPromptReady(tool, raw))
        throw problem(serverMessages.models.checkActionOrDraft, 409);
      this.state(id, tool, raw);
      this.pending.add(id);
      if (tool === "claude") await tx.keys(["M-p"]);
      else if (tool === "opencode") await tx.keys(["C-x", "m"]);
      else {
        await tx.type("/model");
        // Codex coalesces rapid keystrokes as a paste burst, including a following Enter.
        await sleep(250);
        await tx.keys(["Enter"]);
      }
      const result = this.state(id, tool, await this.wait(tx, (menu) => !!menu));
      if (!result.picker) result.notice = serverMessages.models.nativePickerNotRecognized;
      return result;
    });
  }
  select(id, { token, optionId } = {}) {
    return this.sessions.control(id, async (tx) => {
      this.assertModelChangeAllowed(tx.session);
      const tool = tx.session.tool;
      let raw = await tx.screen();
      let menu = parseModelPicker(tool, raw);
      if (!menu || typeof token !== "string" || menu.signature !== token)
        throw problem(serverMessages.models.pickerChangedReopen, 409);
      const option = menu.options.find((x) => x.id === optionId);
      if (!option || menu.selected === null)
        throw problem(serverMessages.models.invalidSelection);
      this.state(id, tool, raw);
      const steps = Number(optionId) - Number(menu.selected);
      if (steps) {
        await tx.keys(Array(Math.abs(steps)).fill(steps > 0 ? "Down" : "Up"));
        raw = await this.wait(
          tx,
          (next) =>
            next?.title === menu.title &&
            sameOption(
              next.options.find((x) => x.id === next.selected),
              option,
            ),
        );
        const next = parseModelPicker(tool, raw);
        if (
          !next ||
          next.title !== menu.title ||
          !sameOption(
            next.options.find((x) => x.id === next.selected),
            option,
          )
        )
          throw problem(serverMessages.models.pickerChangedReopen, 409);
        menu = next;
      }
      if (parseModelPicker(tool, await tx.screen())?.signature !== menu.signature)
        throw problem(serverMessages.models.pickerChangedReopen, 409);
      // Exactly one confirmation. A subsequent effort or consent dialog is a separate action.
      await tx.keys([menu.selectKey]);
      this.pending.add(id);
      return this.state(
        id,
        tool,
        await this.wait(
          tx,
          (next, screen) =>
            next?.signature !== menu.signature &&
            (!!next || modelPromptReady(tool, screen)),
        ),
      );
    });
  }
  cancel(id, { token } = {}) {
    return this.sessions.control(id, async (tx) => {
      const raw = await tx.screen();
      const menu = parseModelPicker(tx.session.tool, raw);
      if (!menu || menu.signature !== token)
        throw problem(serverMessages.models.pickerChangedCheckTerminal, 409);
      await tx.keys(["Escape"]);
      return this.state(
        id,
        tx.session.tool,
        await this.wait(
          tx,
          (next, screen) =>
            next?.signature !== menu.signature &&
            (!!next || modelPromptReady(tx.session.tool, screen)),
        ),
      );
    });
  }
  search(id, { token, query } = {}) {
    return this.sessions.control(id, async (tx) => {
      this.assertModelChangeAllowed(tx.session);
      const raw = await tx.screen();
      const menu = parseModelPicker(tx.session.tool, raw);
      if (!menu?.searchable || menu.signature !== token)
        throw problem(serverMessages.models.pickerChangedReopen, 409);
      if (typeof query !== "string" || query.length > 80 || /[\x00-\x1f\x7f]/.test(query))
        throw problem(serverMessages.models.invalidSearch);
      this.pending.add(id);
      // OpenCode's Ctrl+A is a provider action, not an input shortcut.
      await tx.keys(["C-e", "C-u"]);
      if (query) await tx.type(query);
      return this.state(
        id,
        tx.session.tool,
        await this.wait(tx, (next) => !!next?.searchable),
      );
    });
  }
  guardInput(id, session, raw) {
    const menu = parseModelPicker(session.tool, raw);
    if (menu || (this.pending.has(id) && !modelPromptReady(session.tool, raw)))
      throw problem(serverMessages.models.completeSelectionFirst, 409);
    this.pending.delete(id);
  }
  remove(id) {
    this.known.delete(id);
    this.pending.delete(id);
  }
}
