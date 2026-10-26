import React from "react";
import Icon from "../../components/Icon.jsx";
import { unknownValue } from "../../components/ListRow.jsx";
import { routePath } from "../../app/routes.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { connectionsRoute } from "./routes.js";

/**
 * The categories column of Zugänge (phones: the first subpage): each category with
 * its entry count and, highlighted, how many entries have a problem. Unknown counts
 * show "—", never 0.
 */
export default function ConnectionCategories({ sections, counts, current, navigate }) {
  return (
    <nav className="connections-categories" aria-label={copy.categoriesLabel}>
      <p className="connections-intro">{copy.intro}</p>
      <ul>
        {sections.map((section) => {
          const route = connectionsRoute(section);
          const { count = null, flagged = null } = counts[section] || {};
          return (
            <li key={section}>
              <a
                className="connections-category-link"
                href={routePath(route)}
                aria-current={current === section ? "page" : undefined}
                onClick={(event) => {
                  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey)
                    return;
                  event.preventDefault();
                  navigate(route);
                }}
              >
                <span className="connections-category-name">
                  {copy.sections[section]}
                </span>
                <small
                  className="connections-category-total"
                  aria-label={count === null ? copy.unknownCount : undefined}
                >
                  {count === null ? unknownValue : count}
                </small>
                {flagged > 0 && (
                  <span className="connections-flag" aria-label={copy.flagged(flagged)}>
                    {flagged}
                  </span>
                )}
                <Icon name="chevron" size={14} className="connections-category-chevron" />
              </a>
            </li>
          );
        })}
      </ul>
      <p className="connections-categories-hint">{copy.problemHint}</p>
    </nav>
  );
}
