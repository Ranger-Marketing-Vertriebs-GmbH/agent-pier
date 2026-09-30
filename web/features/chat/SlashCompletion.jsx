import React, { useLayoutEffect, useRef } from "react";
import { chatComposerCopy as copy } from "../../lib/i18n/messages/chat.js";

export default function SlashCompletion({ completion }) {
  const list = useRef(null);
  const { open, id, matches, selected, choose } = completion;
  useLayoutEffect(() => {
    const parent = list.current;
    const item = parent?.children[selected];
    if (!item) return;
    if (item.offsetTop < parent.scrollTop) parent.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > parent.scrollTop + parent.clientHeight)
      parent.scrollTop = item.offsetTop + item.offsetHeight - parent.clientHeight;
  }, [open, selected]);
  if (!open) return null;
  return (
    <div className="chat-slash-popup">
      <div className="chat-slash-heading">
        {copy.slashTitle}
        <small>{copy.slashHint}</small>
      </div>
      <div
        id={id}
        ref={list}
        role="listbox"
        aria-label={copy.slashTitle}
        className="chat-slash-options"
      >
        {matches.map((command, index) => (
          <button
            type="button"
            role="option"
            tabIndex={-1}
            key={command.name}
            id={`${id}-${index}`}
            aria-selected={selected === index}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(command)}
          >
            <span>/{command.name}</span>
            {command.description && <small>{command.description}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}
