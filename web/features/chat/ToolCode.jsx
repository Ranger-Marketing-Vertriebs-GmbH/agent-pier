import React, { memo, useMemo } from "react";
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
const highlighter = createLowlight({
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
function render(nodes) {
  return nodes.map((node, index) =>
    node.type === "text" ? (
      node.value
    ) : (
      <span key={index} className={node.properties?.className?.join(" ")}>
        {render(node.children || [])}
      </span>
    ),
  );
}
export default memo(function ToolCode({ text, language }) {
  const content = useMemo(() => {
    if (text.length > 20000 || !highlighter.registered(language)) return text;
    try {
      return render(highlighter.highlight(language, text).children);
    } catch {
      return text;
    }
  }, [text, language]);
  return <code>{content}</code>;
});
