import React from "react";
import Icon from "../../components/Icon.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import Skeleton, { SkeletonLabel } from "../../components/Skeleton.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { isPlainClick } from "../../components/link-click.js";
import { routePath } from "../../app/routes.js";
import { codingRoute } from "../coding/routes.js";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { startPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import { reaCopy } from "../../lib/i18n/messages/rea.js";
import { toolInstallerCopy } from "../../lib/i18n/messages/tools.js";
import {
  reaUpdate,
  splitToolActions,
  toolActions,
  updateRequired,
} from "./tool-actions.js";
import {
  runToolAction,
  toolActionLabel,
  toolActionShortLabel,
} from "./tool-action-view.js";

// "Update required · 2.1.100 · Requires 2.1.263 or later", as the full grid says it.
function stateLine(tool) {
  if (updateRequired(tool))
    return [
      toolInstallerCopy.updateRequiredBadge,
      tool.version,
      tool.minimumVersion && toolInstallerCopy.minimumVersion(tool.minimumVersion),
    ]
      .filter(Boolean)
      .join(" · ");
  if (!tool.installed) return commonCopy.notInstalled;
  if (reaUpdate(tool))
    return [reaCopy.updateBadge, tool.version].filter(Boolean).join(" · ");
  return [commonCopy.ready, tool.version].filter(Boolean).join(" · ");
}

function ToolRow({ tool, effects }) {
  const menu = useRowMenu();
  const { primary, more } = splitToolActions(toolActions(tool));
  const outdated = updateRequired(tool) || reaUpdate(tool);
  return (
    <li className={`start-tool ${tool.installed ? "" : "unavailable"}`}>
      <ProviderMark tool={tool.id} size="row" />
      <span className="start-row-text">
        <strong>{tool.name}</strong>
        <small className={outdated ? "start-warn" : ""} title={stateLine(tool)}>
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

// Skeleton rows in the shape of the tool rows.
function SkeletonTools({ count }) {
  return (
    <ul className="start-tool-grid">
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="start-tool">
          <Skeleton shape="block" width="30px" height="30px" />
          <span className="start-row-text">
            <strong>
              <Skeleton width="50%" />
            </strong>
            <small>
              <Skeleton width="70%" />
            </small>
          </span>
          <Skeleton shape="block" width="52px" height="33px" />
        </li>
      ))}
    </ul>
  );
}

/**
 * "Your tools": one compact row per CLI and utility with its one primary action and a
 * ⋯ menu that holds every other action of the full grid. Phones show a summary tile
 * that leads to CLIs & extensions. Until the workspace state is `ready`, skeleton
 * rows (`shape`, the remembered number) hold their place.
 */
export default function ToolRows({
  tools,
  profiles = null,
  ready = true,
  shape = 4,
  navigate,
  phone,
  ...effects
}) {
  const readyCount = tools.filter((tool) => tool.installed).length;
  // "4 of 7 ready · 3 profiles"; the profiles only once the accounts are known.
  const facts = [
    tools.length > 0 ? copy.toolsReady(readyCount, tools.length) : "",
    Number.isSafeInteger(profiles) ? copy.toolsProfiles(profiles) : "",
  ]
    .filter(Boolean)
    .join(" · ");
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
        {!ready ? (
          <small aria-busy="true">
            <SkeletonLabel />
            <Skeleton width="70%" />
          </small>
        ) : (
          facts && <small>{facts}</small>
        )}
        {updates > 0 && (
          <small className="start-warn">{copy.toolsUpdates(updates)}</small>
        )}
      </>,
    );
  return (
    <section
      className="start-tools"
      aria-labelledby="start-tools-title"
      aria-busy={!ready || undefined}
    >
      <div className="start-section-head">
        <h2 id="start-tools-title">
          {copy.tools}
          {facts && <span className="start-card-count"> · {facts}</span>}
        </h2>
        {link("start-head-link", copy.toolsLink)}
      </div>
      {!ready ? (
        <>
          <SkeletonLabel />
          <SkeletonTools count={shape} />
        </>
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
