import React, {
  lazy,
  Suspense,
  useId,
  useMemo,
  useState,
  useRef,
  useEffect,
} from "react";
import { chatMessageCopy as copy } from "../../lib/i18n/messages/chat.js";
import { outputPreview, toolBlocks } from "./tool-output.js";
import "./tool-output.css";
const ToolCode = lazy(() => import("./ToolCode.jsx"));
export default function ToolOutput({ text, toolName }) {
  const [limit, setLimit] = useState(8);
  const id = useId();
  const content = useRef(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    if (limit !== 8 || !content.current) return;
    const inner = content.current;
    const update = () =>
      setOverflow(inner.scrollHeight > inner.parentElement.clientHeight + 1);
    const observer = new ResizeObserver(update);
    observer.observe(inner);
    update();
    return () => observer.disconnect();
  }, [limit, text]);
  const blocks = useMemo(() => toolBlocks(text, toolName), [text, toolName]);
  const preview = useMemo(() => outputPreview(blocks, limit), [blocks, limit]);
  return (
    <div className="tool-output">
      <div id={id} className={`tool-output-blocks${limit === 8 ? " is-preview" : ""}`}>
        <div ref={content}>
          {preview.blocks.map((block, index) => (
            <div className="tool-output-block" key={index}>
              {block.label && <div className="tool-output-label">{block.label}</div>}
              <pre>
                <Suspense fallback={<code>{block.text}</code>}>
                  <ToolCode text={block.text} language={block.language} />
                </Suspense>
              </pre>
            </div>
          ))}
        </div>
      </div>
      {(preview.truncated || overflow || limit > 8) && (
        <div className="tool-output-actions">
          {(preview.truncated || (limit === 8 && overflow)) && (
            <button
              type="button"
              aria-controls={id}
              aria-expanded={limit > 8}
              onClick={() => setLimit(limit === 8 ? 200 : limit + 200)}
            >
              {limit === 8 ? copy.expandOutput : copy.moreOutput}
            </button>
          )}
          {limit > 8 && (
            <button
              type="button"
              aria-controls={id}
              aria-expanded="true"
              onClick={() => setLimit(8)}
            >
              {copy.collapseOutput}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
