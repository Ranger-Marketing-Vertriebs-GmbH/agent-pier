import React from "react";
import Icon from "./Icon.jsx";
export default function ListDetail({
  listLabel,
  count,
  items,
  selectedId,
  onSelect,
  renderItem,
  detail,
  mobileBackLabel,
}) {
  const showDetail = selectedId !== "";
  return (
    <div className={`list-detail${showDetail ? " has-detail" : ""}`}>
      <div className="list-detail-list">
        <p className="list-detail-caps">
          {listLabel}
          {typeof count === "number" ? ` · ${count}` : ""}
        </p>
        <div className="list-detail-items">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === selectedId ? "selected" : ""}
              onClick={() => onSelect(item.id)}
            >
              {renderItem(item)}
            </button>
          ))}
        </div>
      </div>
      <div className="list-detail-detail">
        {mobileBackLabel && (
          <button type="button" className="list-detail-back" onClick={() => onSelect("")}>
            <Icon name="back" size={16} />
            {mobileBackLabel}
          </button>
        )}
        {detail}
      </div>
    </div>
  );
}
