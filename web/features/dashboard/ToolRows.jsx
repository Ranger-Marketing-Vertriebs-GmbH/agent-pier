import React from "react";
import Icon from "../../components/Icon.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { isPlainClick } from "../../components/link-click.js";
import { routePath } from "../../app/routes.js";
import { codingRoute } from "../coding/routes.js";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  dashboardPageCopy,
  startPageCopy as copy,
} from "../../lib/i18n/messages/dashboard.js";
import { toolInstallerCopy } from "../../lib/i18n/messages/tools.js";
import { splitToolActions, toolActions, updateRequired } from "./tool-actions.js";
import {
  runToolAction,
  toolActionLabel,
  toolActionShortLabel,
} from "./tool-action-view.js";

function stateLine(tool) {
  if (updateRequired(tool)) return toolInstallerCopy.updateRequiredBadge;
  if (!tool.installed) return commonCopy.notInstalled;
  return [commonCopy.ready, tool.version].filter(Boolean).join(" · ");
}

function ToolRow({ tool, effects }) {
  const menu = useRowMenu();
  const { primary, more } = splitToolActions(toolActions(tool));
  const outdated = updateRequired(tool);
  return (
    <li className={`start-tool ${tool.installed ? "" : "unavailable"}`}>
      <ProviderMark tool={tool.id} size="row" />
      <span className="start-row-text">
        <strong>{tool.name}</strong>
        <small className={outdated ? "start-warn" : ""}>
          <StatusDot tone={outdated ? "warning" : tool.installed ? "ok" : "idle"} />
          {stateLine(tool)}
        </small>
      </span>
      {primary && (
        <button
          type="button"
          className={`button secondary compact start-tool-action ${primary.required ? "update-required" : ""}`}
          aria-label={copy.toolActionLabel(toolActionShortLabel(primary), tool.name)}
          disabled={primary.id === "unavailable"}
          onClick={() => runToolAction(primary, tool, effects)}
        >
          {toolActionShortLabel(primary)}
        </button>
      )}
      {more.length > 0 && (
        <>
          <button
            type="button"
            className="icon-button start-tool-more"
            aria-label={copy.moreActions(tool.name)}
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onClick={menu.toggle}
          >
            <Icon name="more" size={16} />
          </button>
          <RowMenu
            label={copy.moreActions(tool.name)}
            state={menu}
            items={more.map((action) => ({
              id: action.id,
              label: toolActionLabel(action),
              danger: action.id === "remove",
              restoreFocus: false,
              run: () => runToolAction(action, tool, effects),
            }))}
          />
        </>
      )}
    </li>
  );
}

/**
 * "Your tools": one compact row per CLI and utility with its one primary action and a
 * ⋯ menu that holds every other action of the full grid. Phones show a summary tile
 * that leads to CLIs & extensions.
 */
export default function ToolRows({ tools, loading, navigate, phone, ...effects }) {
  const ready = tools.filter((tool) => tool.installed).length;
  const updates = tools.filter(updateRequired).length;
  const route = codingRoute();
  const link = (className, children) => (
    <a
      className={className}
      href={routePath(route)}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        navigate(route);
      }}
    >
      {children}
    </a>
  );
  if (phone)
    return link(
      "start-card start-tile",
      <>
        <strong>{copy.tools}</strong>
        <small>{copy.toolsReady(ready, tools.length)}</small>
        {updates > 0 && (
          <small className="start-warn">{copy.toolsUpdates(updates)}</small>
        )}
      </>,
    );
  return (
    <section className="start-tools" aria-labelledby="start-tools-title">
      <div className="start-section-head">
        <h2 id="start-tools-title">
          {copy.tools}{" "}
          {tools.length > 0 && (
            <span className="start-card-count">
              {copy.toolsReady(ready, tools.length)}
            </span>
          )}
        </h2>
        {link("start-head-link", copy.toolsLink)}
      </div>
      {loading && !tools.length ? (
        <p className="loading" role="status">
          {dashboardPageCopy.workspaceLoading}
        </p>
      ) : (
        <ul className="start-tool-grid">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} effects={effects} />
          ))}
        </ul>
      )}
    </section>
  );
}
