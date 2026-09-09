import * as de from "../de/memory.js";
import * as en from "../en/memory.js";
import { localizedCopy } from "../index.js";
export const memoryCopy = localizedCopy(de.memoryCopy, en.memoryCopy);
