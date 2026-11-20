import React from "react";
import Icon from "../../components/Icon.jsx";
import { unknownValue } from "../../components/ListRow.jsx";
import { crossLinkRoute, routePath } from "../../app/routes.js";
import { codingRoute } from "../coding/routes.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { connectionsRoute } from "./routes.js";

/**
 * The categories column of Zugänge (phones: the first subpage): each category with
 * its entry count and, highlighted, how many entries have a problem. Unknown counts
 * show "—", never 0. Below them a link to CLIs › Accounts: owners look for the CLIs'
 * own sign-ins here (AGENTPIER-391), which live with the CLIs.
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
      <CliAccountsLink current={current} navigate={navigate} />
      <p className="connections-categories-hint">{copy.problemHint}</p>
    </nav>
  );
}

// The link to CLIs › Accounts; its back arrow leads to the category it came from.
function CliAccountsLink({ current, navigate }) {
  const route = crossLinkRoute(codingRoute("accounts"), connectionsRoute(current || ""));
  return (
    <ul className="connections-elsewhere" aria-label={copy.cliAccounts.group}>
      <li>
        <a
          className="connections-category-link"
          href={routePath(route)}
          onClick={(event) => {
            if (event.button || event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            navigate(route);
          }}
        >
          <span className="connections-category-name">{copy.cliAccounts.label}</span>
          <small className="connections-category-total">{copy.cliAccounts.where}</small>
          <Icon name="chevron" size={14} className="connections-category-chevron" />
        </a>
      </li>
    </ul>
  );
}
