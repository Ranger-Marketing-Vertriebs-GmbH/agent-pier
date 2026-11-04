import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
export const highlighter = createLowlight({
  bash,
  json,
  diff,
  javascript,
  typescript,
  python,
  css,
  xml,
  yaml,
});
export function highlightNodes(text, language) {
  if (text.length > 20000 || !highlighter.registered(language))
    return [{ type: "text", value: text }];
  try {
    return highlighter.highlight(language, text).children;
  } catch {
    return [{ type: "text", value: text }];
  }
}
