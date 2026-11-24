import React from "react";
import { readRoute } from "../../app/routes.js";
import GroupLabel from "../../components/GroupLabel.jsx";
import Icon from "../../components/Icon.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { autopilotDashboardCopy as copy } from "../../lib/i18n/messages/autopilot-dashboard.js";
import { pipelineCopy } from "../../lib/i18n/messages/pipelines.js";
import { joinFacts, statusText } from "./order-presentation.js";

// Only AgentPier returns relative links, already scoped to this order's session/run.
// External sources are canonical HTTP(S) URLs from the order view.
export function sourceLink(href, navigate) {
  if (!href) return {};
  if (href.startsWith("/"))
    return {
      href,
      onClick: () => navigate(readRoute(new URL(href, window.location.origin))),
    };
  return { href, target: "_blank" };
}

const resolution = (entry) => copy.resolution[entry.resolution];

function sourceRow(kind, entry) {
  switch (kind) {
    case "runs":
      return {
        label: entry.pipelineName || entry.id,
        sub: joinFacts(entry.pipelineName && entry.id, resolution(entry)),
        value: statusText(entry.status),
        link: entry.link,
        icon: "grid",
      };
    case "tickets":
      return {
        label: joinFacts(entry.key || entry.id, entry.title) || entry.url || copy.ticket,
        sub: joinFacts(entry.source, entry.project, entry.instance, resolution(entry)),
        value: statusText(entry.status),
        link: entry.url,
        icon: "link",
      };
    case "pullRequests":
      return {
        label: entry.url,
        sub: joinFacts(
          entry.source,
          resolution(entry),
          entry.checks && copy.checks(statusText(entry.checks)),
        ),
        value: statusText(entry.status),
        link: entry.url,
        icon: "external",
      };
    case "findings":
      return {
        label: entry.title || copy.finding,
        sub: joinFacts(entry.detail, entry.criterion, entry.stage, entry.runId),
        value: Object.hasOwn(pipelineCopy.severities, entry.severity)
          ? pipelineCopy.severities[entry.severity]
          : entry.severity,
        link: entry.url,
        icon: "search",
      };
  }
}

export default function OrderSources({ entry, navigate }) {
  return ["tickets", "runs", "pullRequests", "findings"].map((kind) => {
    const entries = entry[kind];
    if (!entries?.length) return null;
    return (
      <section key={kind}>
        <GroupLabel as="h3">{copy[kind]}</GroupLabel>
        <ListCard label={copy[kind]}>
          {entries.map((item, index) => {
            const { icon, link, ...row } = sourceRow(kind, item);
            return (
              <ListRow
                key={index}
                {...row}
                icon={<Icon name={icon} size={16} />}
                {...sourceLink(link, navigate)}
              />
            );
          })}
        </ListCard>
      </section>
    );
  });
}
