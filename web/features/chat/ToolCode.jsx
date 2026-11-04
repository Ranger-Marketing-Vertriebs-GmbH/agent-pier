import React, { memo, useMemo } from "react";
import { highlighter } from "../../components/code-highlight.js";
export function render(nodes) {
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
