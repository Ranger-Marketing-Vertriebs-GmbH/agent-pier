import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";

const stageCount = (pipeline) =>
  pipeline.graph.nodes.filter((node) => node.kind === "profile").length;

// Choosing a pipeline opens it for editing; each row also starts a run with it or
// removes it.
export default function DefinitionList({ items, selectedId, onSelect, onRun, onRemove }) {
  return (
    <div className="list-detail-items definition-list">
      {items.map((item) => {
        const selected = item.id === selectedId;
        return (
          <div className={`definition-row${selected ? " selected" : ""}`} key={item.id}>
            <button
              type="button"
              className="definition-select"
              aria-label={copy.edit(item.name)}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(item.id)}
            >
              <strong>{item.name}</strong>
              {item.description && <span>{item.description}</span>}
              <small>{copy.stageCount(stageCount(item))}</small>
            </button>
            <div className="definition-row-actions">
              <button
                type="button"
                className="button secondary compact"
                onClick={() => onRun(item.id)}
              >
                {copy.newRun}
              </button>
              <button
                type="button"
                className="button secondary compact"
                aria-label={copy.remove(item.name)}
                onClick={() => onRemove(item)}
              >
                {commonCopy.remove}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
