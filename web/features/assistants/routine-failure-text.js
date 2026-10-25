import { routineCopy as copy } from "../../lib/i18n/messages/assistant-routines.js";

/** The readable cause of a failed run (server routine-failures.js). */
export const failureText = (failure) =>
  copy.failures[failure?.reason] || copy.failures.other;
