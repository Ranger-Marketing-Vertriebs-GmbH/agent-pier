import path from "node:path";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { assistantProblem } from "./assistant-validation.js";

/** Owner-authored global browser policy; never inferred from an agent's input. */
export class BrowserNetworkSettings {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, "assistants", "browser-network.json");
  }
  get() {
    const state = readJSON(this.file, { revision: 0, allowPrivateNetwork: false });
    if (
      !Number.isSafeInteger(state?.revision) ||
      state.revision < 0 ||
      typeof state.allowPrivateNetwork !== "boolean"
    )
      throw assistantProblem("unavailable", 503);
    return { revision: state.revision, allowPrivateNetwork: state.allowPrivateNetwork };
  }
  validate(input) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["revision", "allowPrivateNetwork"].includes(key),
      ) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 0 ||
      typeof input.allowPrivateNetwork !== "boolean"
    )
      throw assistantProblem("invalid");
    if (input.revision !== this.get().revision) throw assistantProblem("conflict", 409);
    return input.allowPrivateNetwork;
  }
  save(input) {
    const allowPrivateNetwork = this.validate(input);
    const next = { revision: input.revision + 1, allowPrivateNetwork };
    writePrivate(this.file, next);
    return next;
  }
}
