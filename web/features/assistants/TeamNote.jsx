import React from "react";
import Icon from "../../components/Icon.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import RouteLink from "./RouteLink.jsx";
import { agentTeamRoute } from "./settings-routes.js";

// Where a team started or ended in the lead's chat; links to the team in Settings → Work.
export default function TeamNote({ note, navigate, focused = false }) {
  const { team, kind } = note;
  return (
    <p
      id={`assistant-team-note-${note.id.replace(":", "-")}`}
      className={`assistant-note assistant-event assistant-team-note${focused ? " focused" : ""}`}
      data-team={team.id}
      data-team-note={kind}
    >
      <RouteLink
        route={agentTeamRoute(team.parentAssistantId, team.id)}
        navigate={navigate}
      >
        <Icon name="users" size={13} />
        <span>{copy.team.notes[kind](team.objective)}</span>
      </RouteLink>
    </p>
  );
}
