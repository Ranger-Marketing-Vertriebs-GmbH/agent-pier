import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { chatMessageCopy as copy } from "../lib/i18n/messages/chat.js";

// Model output is untrusted: raw HTML is dropped, remote images never load (a text
// placeholder stands in) and every link opens in a new, isolated tab. Callers may
// override single elements, for example to route project file links.
export default function ChatMarkdown({ children, components, urlTransform }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={urlTransform}
      components={{
        a: ({ node: _node, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer noopener" />
        ),
        img: ({ alt }) => (
          <span className="subtle">
            {copy.subtle}
            {alt ? `: ${alt}` : ""}]
          </span>
        ),
        ...components,
      }}
    >
      {children}
    </Markdown>
  );
}
