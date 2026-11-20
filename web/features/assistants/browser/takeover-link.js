import { defaultUrlTransform } from "react-markdown";
import { takeoverHref } from "./browser-entry.js";

/**
 * The chat's URL check for an agent's message: the agent's take-over link
 * (`agentpier:browser-takeover`, see browser-entry.js) passes as it is, every other
 * URL as react-markdown allows it (no javascript: and the like).
 */
export const takeoverUrl = (url) =>
  url === takeoverHref ? url : defaultUrlTransform(url);
