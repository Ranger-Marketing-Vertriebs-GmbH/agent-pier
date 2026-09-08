import * as de from "../de/operations.js";
import * as en from "../en/operations.js";
import { localizedCopy } from "../index.js";
export const operationsCopy = localizedCopy(de.operationsCopy, en.operationsCopy);
export const diagnosticCopy = localizedCopy(de.diagnosticCopy, en.diagnosticCopy);
export const backupCopy = localizedCopy(de.backupCopy, en.backupCopy);
export const importedHistoryCopy = localizedCopy(
  de.importedHistoryCopy,
  en.importedHistoryCopy,
);
