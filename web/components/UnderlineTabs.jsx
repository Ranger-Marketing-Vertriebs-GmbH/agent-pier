import React, { useRef } from "react";
import Icon from "./Icon.jsx";
import { edgeClassNames } from "./scroll-fade.js";
import useScrollFade from "./useScrollFade.js";

// Tabs fill the row on phones and scroll with an edge fade when they do not fit; the
// active tab stays in view with a 48px margin.
export default function UnderlineTabs({
  label,
  tabs,
  selected,
  onSelect,
  disabled = false,
  idPrefix = "underline",
}) {
  const list = useRef(null);
  const { edges, scrollBy } = useScrollFade(list, {
    activeSelector: '[aria-selected="true"]',
    revealKey: `${selected}:${tabs.length}`,
  });
  const move = (event, index) => {
    const count = tabs.length;
    let next = null;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else if (event.key === "ArrowRight") next = (index + 1) % count;
    else if (event.key === "ArrowLeft") next = (index - 1 + count) % count;
    if (next === null) return;
    event.preventDefault();
    onSelect(tabs[next].id);
    event.currentTarget.parentElement.children[next].focus();
  };
  return (
    <div className={edgeClassNames(edges, "underline-tabs-frame")}>
      <button
        type="button"
        className="underline-tabs-arrow left"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => scrollBy(-1)}
      >
        <Icon name="back" size={14} />
      </button>
      <div
        ref={list}
        className={edgeClassNames(edges, "underline-tabs", "scroll-fade")}
        role="tablist"
        aria-label={label}
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`${idPrefix}-tab-${tab.id}`}
            role="tab"
            aria-selected={selected === tab.id}
            aria-controls={`${idPrefix}-tabpanel-${tab.id}`}
            tabIndex={selected === tab.id ? 0 : -1}
            disabled={disabled}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => move(event, index)}
          >
            {tab.label}
            {tab.count !== undefined && <small>{tab.count}</small>}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="underline-tabs-arrow right"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => scrollBy(1)}
      >
        <Icon name="arrow" size={14} />
      </button>
    </div>
  );
}
