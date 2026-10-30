import React, { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../../components/Icon.jsx";
import Segment from "../../components/Segment.jsx";
import { projectGroupsCopy as copy } from "../../lib/i18n/messages/project-groups.js";
import { projectsHubCopy as hubCopy } from "../../lib/i18n/messages/projects.js";
import ProjectGroupNameRow from "./ProjectGroupNameRow.jsx";
import ProjectListItem from "./ProjectListItem.jsx";
import { projectMenuItems } from "./project-menu.js";
import ProjectListSection from "./ProjectListSection.jsx";
import { buildProjectSections, groupNameProblem } from "./project-groups.js";
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
  const nameProblem = (name) => {
    const problem = groupNameProblem(document, name);
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
    </>
  );
}
