import React, { useId } from "react";

/**
 * One Zugänge category: a region named by its heading, with how many entries it has
 * and its actions (add, keys, CLI finds) beside the heading.
 */
export default function CategorySection({ title, count, actions, children }) {
  const id = useId();
  return (
    <section className="connections-category" aria-labelledby={`${id}-title`}>
      <div className="connections-category-head">
        <div className="connections-category-title">
          <h2 id={`${id}-title`}>{title}</h2>
          {count && <span className="connections-category-count">{count}</span>}
        </div>
        {actions && <div className="connections-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
