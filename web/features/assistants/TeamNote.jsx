import React from "react";
import Icon from "../../components/Icon.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import RouteLink from "./RouteLink.jsx";
import { agentTeamRoute } from "./settings-routes.js";

// Where a team started or ended in the lead's chat; links to the team in Settings → Work.
export default function TeamNote({ note, navigate, focused = false }) {
  const { team, kind } = note;
  // The objective is model text of any length; the note clamps it, the title keeps it.
  const text = copy.team.notes[kind](team.objective);
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
        aria-current={focused ? "true" : undefined}
        title={text}
      >
        <Icon name="users" size={13} />
        <span>{text}</span>
      </RouteLink>
    </p>
  );
}
