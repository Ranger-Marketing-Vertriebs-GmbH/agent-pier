import React from "react";
import ListCard from "../../../../components/ListCard.jsx";
import { ToggleRow } from "../../../../components/ListRow.jsx";
import { assistantSettingsCopy } from "../../../../lib/i18n/messages/assistant-settings.js";
import { assistantWorkflowCopy as wf } from "../../../../lib/i18n/messages/assistant-workflows.js";
import { agentRoute, folderLevels } from "../agent-settings-fields.js";
import AccessGroup from "./AccessGroup.jsx";
import GrantRow from "./GrantRow.jsx";
import {
  addProjects,
  candidatesOf,
  grantedItems,
  grantedProjectIds,
  removeProject,
} from "./access-groups.js";

const copy = assistantSettingsCopy.access;

/**
 * Projekte: the projects an agent may use (coding) with its direct folder access per
 * project, the same setting as Projekt › Agenten. An agent of users reaches folders
 * only (`foldersOnly`), read or read and write.
 */
export default function ProjectsAccess({
  assistantId,
  projects,
  draft,
  disabled,
  foldersOnly,
  go,
}) {
  const values = draft.values;
  const ids = grantedProjectIds(values, foldersOnly);
  const entries = grantedItems(projects, ids);
  const levels = foldersOnly ? folderLevels.filter((v) => v !== "none") : folderLevels;
  const levelOptions = levels.map((value) => ({ value, label: wf.folderLevels[value] }));
  const update = (next) => draft.update(next);
  const writing = entries.some((item) => values.projectFiles[item.id] === "write");
  return (
    <AccessGroup
      id="agent-access-projects"
      title={copy.projects}
      hint={copy.sameAsProject}
      entries={entries}
      total={projects ? projects.length : null}
      loading={!projects}
      more={{
        route: agentRoute(assistantId, "access", "projects"),
        open: () => go("access", "projects"),
      }}
      renderRow={(item) => (
        <GrantRow
          key={item.id}
          id={item.id}
          name={item.name}
          sub={item.path}
          disabled={disabled}
          mode={{
            label: copy.folderLabel(item.name),
            value: values.projectFiles[item.id] || (foldersOnly ? "read" : "none"),
            options: levelOptions,
            onChange: (level) =>
              update(addProjects(values, [item.id], level, foldersOnly)),
          }}
          onRevoke={() => update(removeProject(values, item.id, foldersOnly))}
        />
      )}
      picker={{
        typeLabel: copy.projectType,
        candidates: candidatesOf(projects, (item) => ({ sub: item.path })),
        granted: ids,
        modes: levelOptions,
        defaultMode: foldersOnly ? "read" : "none",
        disabled,
        onAdd: (items, mode) =>
          update(
            addProjects(
              values,
              items.map((item) => item.id),
              mode,
              foldersOnly,
            ),
          ),
      }}
      notes={writing && <p className="ssh-grant-warning">{wf.folderWarning}</p>}
    >
      {!foldersOnly && (
        <ListCard>
          <ToggleRow
            label={wf.memoryWrite}
            checked={values.memoryWrite}
            disabled={disabled}
            onChange={(on) => draft.set("memoryWrite", on)}
          />
        </ListCard>
      )}
    </AccessGroup>
  );
}
