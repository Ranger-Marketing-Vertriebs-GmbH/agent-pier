import React, { useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import Icon from "../../components/Icon.jsx";
import Segment from "../../components/Segment.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { projectGroupsCopy as copy } from "../../lib/i18n/messages/project-groups.js";
import { projectsHubCopy as hubCopy } from "../../lib/i18n/messages/projects.js";
import ProjectGroupMenu from "./ProjectGroupMenu.jsx";
import ProjectGroupNameRow from "./ProjectGroupNameRow.jsx";
import ProjectListItem from "./ProjectListItem.jsx";
import { projectMenuItems } from "./project-menu.js";
import ProjectListSection from "./ProjectListSection.jsx";
import { buildProjectSections, groupNameProblem } from "./project-groups.js";
import { normalizePath } from "./project-paths.js";
import useProjectListPrefs from "./useProjectListPrefs.js";
import "./project-list.css";

const sectionTitle = (section) =>
  section.kind === "ungrouped"
    ? copy.ungrouped
    : section.kind === "local"
      ? hubCopy.localOnly
      : section.title;

/**
 * The projects list column: search and view switch on top, then the sections
 * (groups, origins or one flat list) in their own scroll container. `groups` is
 * useProjectGroups(); `isRunning(project)` says whether one of its sessions runs.
 */
export default function ProjectList({
  projects,
  groups,
  selectedId,
  onSelect,
  attentionFor,
  isRunning,
}) {
  const prefs = useProjectListPrefs();
  const [query, setQuery] = useState("");
  // While the name field is open: `{ path }` of a project to move into the new group
  // ("" from the new-group button) and the control to focus again afterwards.
  const [creating, setCreating] = useState(null);
  // Group management: the group whose name field is open, and the one asked about.
  const [renaming, setRenaming] = useState("");
  const [deleting, setDeleting] = useState(null);
  const groupFocus = useRef(null);
  const { document } = groups;
  const sections = useMemo(
    () => buildProjectSections({ projects, document, view: prefs.view, query }),
    [projects, document, prefs.view, query],
  );
  const searching = query.trim() !== "";
  // Focus goes back once the row is gone: to the opener, or to the ⋯ of the project
  // it moved, whose row re-renders in its new section.
  const returnFocus = useRef(null);
  const scroller = useRef(null);
  const closeCreate = () => {
    returnFocus.current = creating;
    setCreating(null);
  };
  useEffect(() => {
    const closed = returnFocus.current;
    if (creating || !closed) return;
    returnFocus.current = null;
    const target = closed.opener?.isConnected
      ? closed.opener
      : closed.path &&
        [...(scroller.current?.querySelectorAll("[data-project-path]") || [])].find(
          (node) => node.dataset.projectPath === closed.path,
        );
    target?.focus();
  }, [creating, sections]);
  // After a rename ends, focus returns to the group's ⋯; after a delete it moves to
  // the header that took its place, or to the list's first header.
  useEffect(() => {
    if (renaming || deleting || !groupFocus.current) return;
    const find = groupFocus.current;
    groupFocus.current = null;
    (find() || scroller.current?.querySelector(".project-section-toggle"))?.focus();
  }, [renaming, deleting, sections]);
  const groupControl = (selector) => () => scroller.current?.querySelector(selector);
  const closeRename = (groupId) => {
    groupFocus.current = groupControl(`[data-group-id="${groupId}"]`);
    setRenaming("");
  };
  const startDelete = (group) => {
    const count = projects.filter(
      (project) => document.assignments[normalizePath(project.path)] === group.id,
    ).length;
    if (count) return setDeleting({ group, count });
    groups.deleteGroup(group.id);
  };
  const confirmDelete = () => {
    const { group } = deleting;
    const at = document.groups.findIndex((item) => item.id === group.id);
    const next = document.groups[at + 1];
    groupFocus.current = groupControl(
      next
        ? `[data-section="group:${next.id}"] .project-section-toggle`
        : "[data-section]",
    );
    setDeleting(null);
    groups.deleteGroup(group.id);
  };
  const nameProblem = (name, exceptId = "") => {
    const problem = groupNameProblem(document, name, exceptId);
    return problem === "required"
      ? copy.nameRequired
      : problem === "taken"
        ? copy.nameTaken
        : "";
  };
  const views = [
    { value: "groups", label: copy.viewGroups },
    { value: "origin", label: copy.viewOrigin },
    { value: "list", label: copy.viewList },
  ];
  return (
    <>
      <div className="project-list-tools">
        <label className="project-search">
          <Icon name="search" size={16} />
          <input
            type="search"
            value={query}
            maxLength={200}
            placeholder={copy.searchPlaceholder}
            aria-label={copy.searchLabel}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="project-view-row">
          <span className="project-view-label" aria-hidden="true">
            {copy.view}
          </span>
          <Segment
            label={copy.view}
            options={views}
            value={prefs.view}
            onChange={prefs.setView}
          />
          {prefs.view === "groups" && (
            <button
              type="button"
              className="icon-button project-new-group"
              aria-label={copy.newGroup}
              onClick={(event) => setCreating({ path: "", opener: event.currentTarget })}
            >
              <Icon name="folder-plus" size={18} />
            </button>
          )}
        </div>
      </div>
      <div className="project-list-scroller" ref={scroller}>
        {creating && (
          <ProjectGroupNameRow
            key={creating.path}
            submitLabel={copy.createGroup}
            validate={nameProblem}
            onSubmit={async (name) => {
              await groups.createGroup(name, creating.path);
              closeCreate();
            }}
            onCancel={closeCreate}
          />
        )}
        {sections.map((section) => (
          <ProjectListSection
            key={section.key}
            section={section}
            title={sectionTitle(section)}
            open={searching || !prefs.isCollapsed(section.key)}
            onToggle={() => prefs.toggleSection(section.key)}
            editor={
              renaming && renaming === section.groupId ? (
                <ProjectGroupNameRow
                  initialName={section.title}
                  submitLabel={commonCopy.save}
                  validate={(name) => nameProblem(name, section.groupId)}
                  onSubmit={async (name) => {
                    await groups.renameGroup(section.groupId, name);
                    closeRename(section.groupId);
                  }}
                  onCancel={() => closeRename(section.groupId)}
                />
              ) : null
            }
            actions={
              section.kind === "group" ? (
                <ProjectGroupMenu
                  group={{ id: section.groupId, name: section.title }}
                  first={section.groupId === document.groups[0]?.id}
                  last={section.groupId === document.groups.at(-1)?.id}
                  onRename={() => setRenaming(section.groupId)}
                  onMove={(offset) => groups.moveGroup(section.groupId, offset)}
                  onDelete={() =>
                    startDelete({ id: section.groupId, name: section.title })
                  }
                />
              ) : null
            }
          >
            {section.projects.map((item) => {
              const current = groups.groupOf(item.path);
              return (
                <ProjectListItem
                  key={item.id}
                  item={item}
                  attention={attentionFor(item)}
                  running={isRunning(item)}
                  selected={item.id === selectedId}
                  onSelect={onSelect}
                  menuItems={projectMenuItems({
                    groups: document.groups,
                    current,
                    onMove: (groupId) => groups.moveProject(item.path, groupId),
                    onNewGroup: (opener) => setCreating({ path: item.path, opener }),
                    onRemove: () => groups.removeProject(item.path),
                  })}
                />
              );
            })}
          </ProjectListSection>
        ))}
        {searching && !sections.length && (
          <p className="project-no-matches">{copy.noMatches(query.trim())}</p>
        )}
      </div>
      {deleting && (
        <ConfirmDialog
          destructive
          focusCancel
          title={copy.deleteGroupTitle(deleting.group.name)}
          body={copy.deleteGroupBody(deleting.count)}
          confirmLabel={commonCopy.delete}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
