import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

/** A cleanup refusal with its browser-visible message (storage-cleanup catalogs). */
export const cleanupProblem = (key, status = 400) =>
  Object.assign(problem(serverMessages.storageCleanup[key], status), { code: key });
