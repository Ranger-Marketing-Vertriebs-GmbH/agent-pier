import React, { useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import Icon from "../../components/Icon.jsx";
import Segment from "../../components/Segment.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import useMediaQuery from "../../lib/useMediaQuery.js";
import { projectGroupsCopy as copy } from "../../lib/i18n/messages/project-groups.js";
import { projectsHubCopy as hubCopy } from "../../lib/i18n/messages/projects.js";
import ProjectGroupMenu from "./ProjectGroupMenu.jsx";
import ProjectGroupNameRow from "./ProjectGroupNameRow.jsx";
import ProjectListItem from "./ProjectListItem.jsx";
import { projectMenuItems } from "./project-menu.js";
import ProjectListSection from "./ProjectListSection.jsx";
import { buildProjectSections, groupNameProblem } from "./project-groups.js";
import { normalizePath } from "./project-paths.js";
import useProjectDrag from "./useProjectDrag.js";
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
  const searching = query.trim() !== "";
  const scroller = useRef(null);
  // Drag and drop: a fine pointer, view "Groups", no search (rows may be hidden then).
  const finePointer = useMediaQuery("(pointer: fine)");
  // Drops are announced once saved; the count makes a repeated message differ, so it
  // is announced again (a trailing no-break space alternates).
  const [announcement, setAnnouncement] = useState({ text: "", count: 0 });
  const announce = (text) => setAnnouncement((last) => ({ text, count: last.count + 1 }));
  const { drag, press } = useProjectDrag({
    enabled: finePointer && prefs.view === "groups" && !searching,
    scroller,
    onOpen: (key) => prefs.isCollapsed(key) && prefs.toggleSection(key),
    onDrop: async (source, target) => {
      if (target.type === "reorder") {
        if (await groups.moveGroupTo(source.groupId, target.index))
          announce(copy.groupReordered(source.name, target.index + 1));
        return;
      }
      const group = document.groups.find((entry) => entry.id === target.groupId);
      if (await groups.moveProject(source.path, target.groupId))
        announce(copy.groupMoved(source.name, group ? group.name : copy.ungrouped));
    },
  });
  const dragged = drag?.source;
  const target = drag?.target;
  const sections = useMemo(() => {
    const list = buildProjectSections({ projects, document, view: prefs.view, query });
    // A dragged project can always be dropped on "No group", even when it is empty.
    if (dragged?.type === "project" && !list.some((entry) => entry.kind === "ungrouped"))
      list.push({ key: "ungrouped", kind: "ungrouped", projects: [], count: 0 });
    return list;
  }, [projects, document, prefs.view, query, dragged]);
  // The insertion line of a dragged group: before group `target.before`, or after the last.
  const insertLine = (groupId) => {
    if (target?.type !== "reorder") return "";
    const index = document.groups.findIndex((group) => group.id === groupId);
    if (index === target.before) return "before";
    return index === document.groups.length - 1 && target.before === index + 1
      ? "after"
      : "";
  };
  // Focus goes back once the row is gone: to the opener, or to the ⋯ of the project
  // it moved, whose row re-renders in its new section.
  const returnFocus = useRef(null);
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
  // A rename field whose group vanished (live update) must not block focus handoffs.
  useEffect(() => {
    if (renaming && !document.groups.some((group) => group.id === renaming))
      setRenaming("");
  }, [renaming, document]);
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
  // Focus moves to the header after the deleted group ("No group" after the last one).
  const removeGroup = (group) => {
    const next = document.groups[document.groups.findIndex((g) => g.id === group.id) + 1];
    groupFocus.current = groupControl(
      `[data-section="${next ? `group:${next.id}` : "ungrouped"}"] .project-section-toggle`,
    );
    groups.deleteGroup(group.id);
  };
  // The count and `withoutGroup` read the same assignments; assignments to folders that
  // are not in the project list are intentionally ignored.
  const startDelete = (group) => {
    const count = projects.filter(
      (project) => document.assignments[normalizePath(project.path)] === group.id,
    ).length;
    if (count) return setDeleting({ group, count });
    removeGroup(group);
  };
  const confirmDelete = () => {
    const { group } = deleting;
    setDeleting(null);
    removeGroup(group);
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
      <div className={`project-list-scroller ${drag ? "dragging" : ""}`} ref={scroller}>
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
            onPress={
              press && section.kind === "group"
                ? press({ type: "group", groupId: section.groupId, name: section.title })
                : undefined
            }
            dragging={dragged?.type === "group" && dragged.groupId === section.groupId}
            dropTarget={target?.type === "assign" && target.key === section.key}
            insert={section.kind === "group" ? insertLine(section.groupId) : ""}
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
                  onPress={press?.({
                    type: "project",
                    path: item.path,
                    name: item.name,
                    groupId: current?.id ?? null,
                  })}
                  dragging={dragged?.type === "project" && dragged.path === item.path}
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
      <p className="visually-hidden" role="status">
        {announcement.text}
        {announcement.count % 2 ? "\u00a0" : ""}
      </p>
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
