import React from "react";
import { Pagination } from "../../components/Pagination.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  extensionsHubCopy as hub,
  profileExtensionsCopy as copy,
} from "../../lib/i18n/messages/extensions.js";
import ExtensionTable, { ExtensionHint } from "./ExtensionTable.jsx";
import ExtensionsFrame from "./ExtensionsFrame.jsx";

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
      {(data?.skills.note || account.tool === "codex") && (
        <ExtensionHint>
          {data?.skills.note && <p>{data.skills.note}</p>}
          {account.tool === "codex" && <p>{copy.extensionScopeNote}</p>}
        </ExtensionHint>
      )}
      <ExtensionTable
        heads={[hub.headSkill, hub.headScope, hub.headStatus]}
        empty={skillSearch ? copy.noMatchingSkills : copy.noSkills}
        rows={skillPaging.items.map((skill) => ({
          key: skill.id,
          name: skill.name,
          sub: skill.description,
          details: <code className="extension-path">{skill.path}</code>,
          tag: skill.scope,
          status: {
            on: skill.removable,
            text: skill.removable ? hub.installedHere : hub.readOnly,
          },
          actions: skill.removable && (
            <button
              className="button secondary compact"
              disabled={Boolean(busy)}
              aria-label={commonCopy.removeSkillLabel(skill.name)}
              onClick={() =>
                setConfirm({ kind: "skill", id: skill.id, name: skill.name })
              }
            >
              {commonCopy.remove}
            </button>
          ),
        }))}
      />
      <Pagination paging={skillPaging} label={copy.skillsHeading} />
    </ExtensionsFrame>
  );
}
