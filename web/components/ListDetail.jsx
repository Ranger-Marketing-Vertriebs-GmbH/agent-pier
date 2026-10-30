import React from "react";
import Icon from "./Icon.jsx";
// `list` replaces the default caption and item buttons with a page's own list (the
// projects page); the `nav` landmark and the phone list/detail switch stay.
export default function ListDetail({
  listLabel,
  count,
  items,
  selectedId,
  onSelect,
  renderItem,
  list,
  detail,
  mobileBackLabel,
  disabled = false,
  className = "",
}) {
  const showDetail = selectedId !== "";
  return (
    <div
      className={["list-detail", showDetail ? "has-detail" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      <nav className="list-detail-list" aria-label={listLabel}>
        {list ?? (
          <>
            <p className="list-detail-caps" aria-hidden="true">
              {listLabel}
              {typeof count === "number" ? ` · ${count}` : ""}
            </p>
            <div className="list-detail-items">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === selectedId ? "selected" : ""}
                  aria-current={item.id === selectedId ? "true" : undefined}
                  disabled={disabled}
                  onClick={() => onSelect(item.id)}
                >
                  {renderItem(item)}
                </button>
              ))}
            </div>
          </>
        )}
      </nav>
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
