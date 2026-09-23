import { germanServerMessages } from "./catalog-de.js";
import { englishServerMessages } from "./catalog-en.js";

/** Server message catalogs by language, for the server and tests. */
export const serverCatalogs = Object.freeze({
  de: germanServerMessages,
  en: englishServerMessages,
});
