import React from "react";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  extensionsHubCopy as hub,
  profileExtensionsCopy as copy,
} from "../../lib/i18n/messages/extensions.js";
import ExtensionHint from "./ExtensionHint.jsx";
import ExtensionsFrame from "./ExtensionsFrame.jsx";
import RowLines from "./RowLines.jsx";
import { skillScopeLabel } from "./useProfileExtensions.js";

// A keyed scope is translated before it enters the notice; older payloads keep note.
const skillsNote = (skills) =>
  skills?.scopeKey ? copy.skillVisibilityNotice(skillScopeLabel(skills)) : skills?.note;

export default function SkillsTab({ ext, account, request, hideError }) {
  const { data, busy, setConfirm, skillQuery, setSkillQuery, skillPaging, skillSearch } =
    ext;
  return (
    <ExtensionsFrame {...{ ext, account, request, hideError }}>
      <div className="extension-toolbar">
        <input
          type="search"
          aria-label={commonCopy.searchSkills}
          value={skillQuery}
          onChange={(event) => setSkillQuery(event.target.value)}
          placeholder={copy.extensionSectionPlaceholder}
        />
      </div>
      {skillsNote(data?.skills) && (
        <ExtensionHint>
          <p>{skillsNote(data.skills)}</p>
        </ExtensionHint>
      )}
      {skillPaging.items.length ? (
        <ListCard label={copy.skillsHeading} className="extension-list">
          {skillPaging.items.map((skill) => (
            <ListRow
              key={skill.id}
              label={skill.name}
              sub={
                <RowLines
                  lines={[
                    skill.description,
                    `${skillScopeLabel(skill)} · ${skill.removable ? hub.installedHere : hub.readOnly}`,
                    <code key="path" className="extension-path">
                      {skill.path}
                    </code>,
                  ]}
                />
              }
              onDelete={
                skill.removable
                  ? () => setConfirm({ kind: "skill", id: skill.id, name: skill.name })
                  : undefined
              }
              deleteLabel={commonCopy.removeSkillLabel(skill.name)}
              disabled={Boolean(busy)}
            />
          ))}
        </ListCard>
      ) : (
        <p className="extension-empty">
          {skillSearch ? copy.noMatchingSkills : copy.noSkills}
        </p>
      )}
      <Pagination paging={skillPaging} label={copy.skillsHeading} />
    </ExtensionsFrame>
  );
}
