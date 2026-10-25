import * as de from "../de/secrets.js";
import * as en from "../en/secrets.js";
import { localizedCopy } from "../index.js";

export const secretsCopy = localizedCopy(de.secretsCopy, en.secretsCopy);
