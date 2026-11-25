import React, { useState } from "react";
import FilterChips from "../../components/FilterChips.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  extensionsHubCopy as hub,
  profileExtensionsCopy as copy,
} from "../../lib/i18n/messages/extensions.js";
import { skillListCopy as listCopy } from "../../lib/i18n/messages/skill-scan.js";
import ExtensionHint from "./ExtensionHint.jsx";
import ExtensionsFrame from "./ExtensionsFrame.jsx";
import SkillDetail from "./SkillDetail.jsx";
import SkillGroups, { SkillRow } from "./SkillGroups.jsx";
import { groupMetaLine, groupSkills, sharedRevision } from "./skill-groups.js";
import { skillScopeLabel } from "./useProfileExtensions.js";

// A keyed scope is translated before it enters the notice; older payloads keep note.
const skillsNote = (skills) =>
  skills?.scopeKey ? copy.skillVisibilityNotice(skillScopeLabel(skills)) : skills?.note;

/** The group of a CLI skill: its GitHub repository, its MCP package, else its scope. */
export function cliSkillSource(skill) {
  if (skill.origin?.repository)
    return {
      key: `github:${skill.origin.repository}`,
      rank: 0,
      title: skill.origin.repository,
    };
  if (skill.package)
    return {
      key: `package:${skill.package.name}@${skill.package.version}`,
      rank: 1,
      title: copy.groupPackage(skill.package.name),
      version: skill.package.version,
    };
  const title = skillScopeLabel(skill);
  return { key: `scope:${skill.scopeKey || title}`, rank: 2, title };
}

function groupMeta(group) {
  const shared = group.rank === 0 ? sharedRevision(group.skills) : null;
  return groupMetaLine([
    shared && listCopy.revision(shared.ref, shared.commit),
    group.version && copy.packageVersion(group.version),
    listCopy.skillCount(group.skills.length),
  ]);
}

const stateOf = (skill) => (skill.removable ? hub.installedHere : hub.readOnly);

function CliSkillDetail({ skill, busy, close, remove }) {
  const origin = skill.origin;
  return (
    <SkillDetail
      title={skill.name}
      subtitle={`${skillScopeLabel(skill)} · ${stateOf(skill)}`}
      close={close}
      descriptionLabel={copy.whenUsed}
      description={skill.description}
      factsLabel={listCopy.factsLabel}
      facts={[
        [copy.factScope, skillScopeLabel(skill)],
        [
          listCopy.factSource,
          origin?.commit
            ? copy.githubOrigin(
                origin.repository,
                origin.refKind,
                origin.ref,
                origin.commit,
              )
            : skill.package &&
              copy.packageOrigin(skill.package.name, skill.package.version),
        ],
        [
          hub.path,
          <code key="path" className="extension-path">
            {skill.path}
          </code>,
        ],
      ]}
      actions={
        skill.removable && (
          <button
            type="button"
            className="button destructive"
            aria-label={commonCopy.removeSkillLabel(skill.name)}
            disabled={busy}
            onClick={remove}
          >
            {commonCopy.remove}
          </button>
        )
      }
    >
      {!skill.removable && !skill.package && (
        <p className="skill-detail-note">{copy.readOnlyNote}</p>
      )}
    </SkillDetail>
  );
}

export default function SkillsTab({ ext, account, request, hideError }) {
  const { data, busy, setConfirm, skillQuery, setSkillQuery, skillPaging, skillSearch } =
    ext;
  const [openId, setOpenId] = useState(null);
  const all = data?.skills?.items || [];
  const open = all.find((skill) => skill.id === openId) || null;
  const groups = groupSkills(skillPaging.items, cliSkillSource).map((group) => ({
    ...group,
    meta: groupMeta(group),
  }));
  const count = (filter) =>
    ext.skillMatches.filter(
      (skill) => filter === "all" || (filter === "here") === Boolean(skill.removable),
    ).length;
  return (
    <ExtensionsFrame {...{ ext, account, request, hideError }}>
      <div className="extension-toolbar">
        <input
          type="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-label={commonCopy.searchSkills}
          value={skillQuery}
          onChange={(event) => setSkillQuery(event.target.value)}
          placeholder={copy.extensionSectionPlaceholder}
        />
      </div>
      {all.length > 0 && (
        <FilterChips
          label={listCopy.filterLabel}
          value={ext.skillFilter}
          onChange={ext.setSkillFilter}
          options={[
            { value: "all", label: listCopy.filterAll, count: count("all") },
            { value: "here", label: hub.installedHere, count: count("here") },
            { value: "readOnly", label: hub.readOnly, count: count("readOnly") },
          ]}
        />
      )}
      {skillsNote(data?.skills) && (
        <ExtensionHint>
          <p>{skillsNote(data.skills)}</p>
        </ExtensionHint>
      )}
      {groups.length ? (
        <SkillGroups
          label={copy.skillsHeading}
          groups={groups}
          row={(skill) => (
            <SkillRow
              key={skill.id}
              name={skill.name}
              description={skill.description}
              value={stateOf(skill)}
              onClick={() => setOpenId(skill.id)}
            />
          )}
        />
      ) : (
        <p className="extension-empty">
          {skillSearch || ext.skillFilter !== "all"
            ? copy.noMatchingSkills
            : copy.noSkills}
        </p>
      )}
      <Pagination paging={skillPaging} label={copy.skillsHeading} />
      {open && (
        <CliSkillDetail
          skill={open}
          busy={Boolean(busy)}
          close={() => setOpenId(null)}
          remove={() => {
            // The confirmation is part of the page, so the detail view makes room.
            setOpenId(null);
            setConfirm({ kind: "skill", id: open.id, name: open.name });
          }}
        />
      )}
    </ExtensionsFrame>
  );
}
