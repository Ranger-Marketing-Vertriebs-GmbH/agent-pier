import { germanServerMessages } from "./catalog-de.js";
import { scripts } from "./de/scripts.js";

/** German product locale shared by backend routes and operational scripts. */
export const serverMessages = Object.freeze({ ...germanServerMessages, scripts });
