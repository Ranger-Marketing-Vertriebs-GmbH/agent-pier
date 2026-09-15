import * as de from "../de/files.js";
import * as en from "../en/files.js";
import { localizedCopy } from "../index.js";
export const filesCopy = localizedCopy(de.filesCopy, en.filesCopy);
export const fileErrorMessage = (code, status) =>
  filesCopy.errors[code] || filesCopy.requestFailed(status);
