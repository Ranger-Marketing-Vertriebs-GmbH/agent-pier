import React from "react";
export default function UnderlineTabs({
  label,
  tabs,
  selected,
  onSelect,
  disabled = false,
}) {
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
    <div className="underline-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          id={`underline-tab-${tab.id}`}
          role="tab"
          aria-selected={selected === tab.id}
          aria-controls={`underline-tabpanel-${tab.id}`}
          tabIndex={selected === tab.id ? 0 : -1}
          disabled={disabled}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => move(event, index)}
        >
          {tab.label}
          {tab.count !== undefined && <span>{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
