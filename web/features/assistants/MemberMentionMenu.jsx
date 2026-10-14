import React from "react";
import { leadRequestCopy } from "../../lib/i18n/messages/lead-requests.js";
import "./member-mentions.css";

// The listbox of the @mention autocomplete above a lead's composer. The textarea
// keeps the focus and points into the list (aria-activedescendant); a press on an option picks it without
// blurring, by mouse, pen or touch. Only mousedown is cancelled to keep the focus:
// WebKit (iOS Safari) drops the click of a tap whose pointerdown was cancelled.
// Always mounted so aria-controls resolves.
export default function MemberMentionMenu({ mention }) {
  const copy = leadRequestCopy.mentions;
  return (
    <ul
      id={mention.listId}
      role="listbox"
      aria-label={copy.list}
      className="member-mentions"
      hidden={!mention.open}
    >
      {mention.options.map((member, index) => (
        <li
          key={member.id}
          id={mention.optionId(index)}
          role="option"
          aria-selected={index === mention.active}
          className="member-mention-option"
          onMouseDown={(event) => event.preventDefault()}
          onPointerEnter={() => mention.hover(index)}
          onClick={() => mention.choose(member)}
        >
          <span className="member-mention-text">
            <span className="member-mention-name">{member.name}</span>
            {member.role && <span className="member-mention-role">{member.role}</span>}
          </span>
          <span className={`member-mention-badge ${member.lifetime}`}>
            {member.lifetime === "permanent" ? copy.permanent : copy.temporary}
          </span>
        </li>
      ))}
    </ul>
  );
}
