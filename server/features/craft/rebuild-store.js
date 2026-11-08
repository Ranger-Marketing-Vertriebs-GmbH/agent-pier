import path from "node:path";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { logCraftFailure } from "./craft-log.js";
import { craftHome } from "../tools/craft-home.js";

/** The owner's defaults for new rebuilds. */
export const defaultRebuildSettings = Object.freeze({
  accountId: null,
  mode: "clean-room",
  autoMode: false,
});

function storedSettings(value) {
  const source = record(value) ? value : {};
  return {
    accountId: typeof source.accountId === "string" ? source.accountId : null,
    mode: source.mode === "deep" ? "deep" : "clean-room",
    autoMode: source.autoMode === true,
  };
}

const storedRecord = (value) =>
  record(value) &&
  typeof value.id === "string" &&
  typeof value.folder === "string" &&
  typeof value.request === "string" &&
  typeof value.accountId === "string";

/**
 * The rebuilds AgentPier started and the owner's defaults, in
 * `<dataDir>/craft-anything/rebuilds.json` (0600, written atomically). A missing or
 * unreadable file reads as empty.
 */
export class RebuildStore {
  constructor(dataDir) {
    this.file = path.join(craftHome(dataDir), "rebuilds.json");
  }
  /** `{ settings, records }`. */
  load() {
    let saved = null;
    try {
      saved = readJSON(this.file, null);
    } catch (error) {
      logCraftFailure("read the Craft Anything rebuilds", error);
    }
    const source = record(saved) ? saved : {};
    return {
      settings: storedSettings(source.settings),
      records: Array.isArray(source.rebuilds)
        ? source.rebuilds.filter(storedRecord).map((item) => structuredClone(item))
        : [],
    };
  }
  save({ settings, records }) {
    writePrivate(this.file, { version: 1, settings, rebuilds: records });
  }
}
