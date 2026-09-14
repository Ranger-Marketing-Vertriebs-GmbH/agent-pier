import React from "react";
import { fileEditorCopy as copy } from "../../lib/i18n/messages/file-editor.js";
export default function FileEditorTabs({ tabs, activeId, activate }) {
  return (
    <div className="file-editor-tabs" role="tablist" aria-label={copy.tabs}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          id={`file-editor-tab-${tab.id}`}
          tabIndex={tab.id === activeId ? 0 : -1}
          aria-selected={tab.id === activeId}
          onKeyDown={(event) => {
            const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            const position = tabs.findIndex((item) => item.id === tab.id);
            const index =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : (position + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
                    tabs.length;
            activate(tabs[index].id);
            event.currentTarget.parentElement.children[index].focus();
          }}
          aria-controls="file-editor-panel"
          onClick={() => activate(tab.id)}
          title={`${copy.scopeLabel(tab.scope.kind, tab.scope.root)}: ${tab.path}`}
        >
          {tab.path}
          {tab.dirty ? " •" : ""}
        </button>
      ))}
    </div>
  );
}
