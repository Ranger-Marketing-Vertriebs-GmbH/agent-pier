import React from "react";

/** A page of her app: the header, one content column and an optional save bar. */
export function UserPage({ header, children, bar }) {
  return (
    <div className="user-page">
      {header}
      <div className="user-page-body">
        <div className="user-page-content">{children}</div>
      </div>
      {bar}
    </div>
  );
}
