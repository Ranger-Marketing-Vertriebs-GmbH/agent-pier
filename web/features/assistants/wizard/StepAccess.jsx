import React, { useCallback, useEffect, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { SelectRow, ToggleRow } from "../../../components/ListRow.jsx";
import api from "../../../lib/api.js";
import { agentWizardCopy } from "../../../lib/i18n/messages/agent-wizard.js";
import { assistantGithubCopy as githubCopy } from "../../../lib/i18n/messages/assistant-github.js";
import { assistantSettingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantSshCopy as sshCopy } from "../../../lib/i18n/messages/assistant-ssh.js";
import { assistantWorkflowCopy as wf } from "../../../lib/i18n/messages/assistant-workflows.js";
import { connectionsRoute } from "../../connections/routes.js";
import { assistantApi } from "../assistant-api.js";
import {
  folderLevels,
  setSshGrant,
  sshModes,
} from "../settings/agent-settings-fields.js";
import { defaultGithubProfile, githubLevels } from "../settings/agent-github-fields.js";
import AccessGroup from "../settings/access/AccessGroup.jsx";
import GrantRow from "../settings/access/GrantRow.jsx";
import {
  addIds,
  addProjects,
  addSshGrants,
  candidatesOf,
  grantedItems,
  grantedProjectIds,
  removeId,
  removeProject,
} from "../settings/access/access-groups.js";
import SetupSheet from "./SetupSheet.jsx";

const copy = assistantSettingsCopy.access;
const all = { expanded: true };
const endpoint = (host) =>
  [
    host.type === "sftp" ? sshCopy.sftp : "",
    sshCopy.endpoint(host.username, host.host, host.port),
  ]
    .filter(Boolean)
    .join(" · ");
// Where "+ … anlegen" sets a missing source up.
const sources = {
  projects: [copy.projectType, { view: "projects" }],
  mcp: [copy.mcpType, connectionsRoute("mcp-servers", "new")],
  pipelines: [copy.pipelineType, { view: "pipelines" }],
  ssh: [copy.sshType, connectionsRoute("ssh", "new")],
  github: ["GitHub", connectionsRoute("github")],
  secrets: [copy.secretType, connectionsRoute("secrets", "new")],
};

function useSources() {
  const [catalog, setCatalog] = useState(null);
  const [servers, setServers] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [list, mcp] = await Promise.all([
        api("/assistant-workspace-catalog"),
        assistantApi.mcpServers(),
      ]);
      setCatalog(list);
      setServers(Array.isArray(mcp) ? mcp : mcp?.servers || []);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return { catalog, servers, error, load };
}

/**
 * Schritt 4 (handoff 5.3): optional grants with the inline add fields of the Access
 * tab (5.5): projects (folder access, coding start), MCP servers, pipelines with
 * their two switches, SSH/SFTP with a mode, the GitHub level and secrets. An empty
 * source offers "+ … anlegen" in a side sheet. Agents of users: folders and MCP only.
 */
export default function StepAccess({ d, set }) {
  const { catalog, servers, error, load } = useSources();
  const [creating, setCreating] = useState("");
  const user = Boolean(d.owner);
  const projects = catalog?.projects ?? null;
  const pipelines = catalog?.pipelines ?? null;
  const hosts = catalog?.sshHosts ?? null;
  const secrets = catalog?.secrets ?? null;
  const profiles = catalog?.github?.profiles || [];
  const createButton = (key, total) =>
    total === 0 && (
      <button
        type="button"
        className="group-label-action agent-wizard-setup"
        onClick={() => setCreating(key)}
      >
        {agentWizardCopy.access.create(sources[key][0])}
      </button>
    );
  const levels = user ? folderLevels.filter((v) => v !== "none") : folderLevels;
  const levelOptions = levels.map((value) => ({ value, label: wf.folderLevels[value] }));
  const projectIds = grantedProjectIds(d, user);
  const modeOptions = sshModes.map((value) => ({ value, label: sshCopy.modes[value] }));
  const list = (key, title, items, selected, field, typeLabel, children) => (
    <AccessGroup
      id={`agent-wizard-${key}`}
      title={title}
      entries={grantedItems(items, selected)}
      total={items ? items.length : null}
      loading={!items && !error}
      more={all}
      renderRow={(item) => (
        <GrantRow
          key={item.id}
          id={item.id}
          name={item.name}
          onRevoke={() => set({ [field]: removeId(selected, item.id) })}
        />
      )}
      picker={{
        typeLabel,
        candidates: candidatesOf(items),
        granted: selected,
        onAdd: (added) =>
          set({
            [field]: addIds(
              selected,
              added.map((item) => item.id),
            ),
          }),
      }}
      notes={createButton(key, items?.length)}
    >
      {children}
    </AccessGroup>
  );
  return (
    <>
      <p className="field-description">{agentWizardCopy.access.intro}</p>
      <ErrorMessage error={error} />
      <AccessGroup
        id="agent-wizard-projects"
        title={copy.projects}
        hint={copy.sameAsProject}
        entries={grantedItems(projects, projectIds)}
        total={projects ? projects.length : null}
        loading={!projects && !error}
        more={all}
        renderRow={(item) => (
          <GrantRow
            key={item.id}
            id={item.id}
            name={item.name}
            sub={item.path}
            mode={{
              label: copy.folderLabel(item.name),
              value: d.projectFiles[item.id] || (user ? "read" : "none"),
              options: levelOptions,
              onChange: (level) => set(addProjects(d, [item.id], level, user)),
            }}
            onRevoke={() => set(removeProject(d, item.id, user))}
          />
        )}
        picker={{
          typeLabel: copy.projectType,
          candidates: candidatesOf(projects, (item) => ({ sub: item.path })),
          granted: projectIds,
          modes: levelOptions,
          defaultMode: user ? "read" : "none",
          onAdd: (items, mode) =>
            set(
              addProjects(
                d,
                items.map((item) => item.id),
                mode,
                user,
              ),
            ),
        }}
        notes={createButton("projects", projects?.length)}
      />
      {list("mcp", copy.mcp, servers, d.mcpServers, "mcpServers", copy.mcpType)}
      {user ? (
        <p className="agent-locked-notice" role="note">
          {agentWizardCopy.access.userOnly}
        </p>
      ) : (
        <>
          {list(
            "pipelines",
            copy.pipelines,
            pipelines,
            d.pipelineIds,
            "pipelineIds",
            copy.pipelineType,
            <ListCard>
              {["autonomous", "publish"].map((key) => (
                <ToggleRow
                  key={key}
                  label={wf[key]}
                  checked={d[key]}
                  onChange={(on) => set({ [key]: on })}
                />
              ))}
            </ListCard>,
          )}
          <AccessGroup
            id="agent-wizard-ssh"
            title={copy.ssh}
            hint={sshCopy.intro}
            entries={d.sshAccesses
              .map((grant) => ({
                ...grant,
                host: (hosts || []).find((h) => h.id === grant.accessId),
              }))
              .filter((entry) => entry.host)
              .map((entry) => ({ id: entry.accessId, ...entry }))}
            total={hosts ? hosts.length : null}
            loading={!hosts && !error}
            more={all}
            renderRow={(entry) => (
              <GrantRow
                key={entry.id}
                id={entry.id}
                name={entry.host.name}
                sub={endpoint(entry.host)}
                mode={{
                  label: copy.modeLabel(entry.host.name),
                  value: entry.mode,
                  options: modeOptions,
                  onChange: (mode) =>
                    set({ sshAccesses: setSshGrant(d.sshAccesses, entry.id, mode) }),
                }}
                onRevoke={() =>
                  set({ sshAccesses: setSshGrant(d.sshAccesses, entry.id, null) })
                }
              />
            )}
            picker={{
              typeLabel: copy.sshType,
              candidates: candidatesOf(hosts, (host) => ({
                sub: endpoint(host),
                group: host.projectName || undefined,
              })),
              granted: d.sshAccesses.map((grant) => grant.accessId),
              modes: modeOptions,
              defaultMode: "approval",
              onAdd: (items, mode) =>
                set({
                  sshAccesses: addSshGrants(
                    d.sshAccesses,
                    items.map((item) => item.id),
                    mode,
                  ),
                }),
            }}
            notes={createButton("ssh", hosts?.length)}
          />
          <ListCard label={copy.github}>
            <SelectRow
              label={agentWizardCopy.access.github}
              value={d.github?.level || ""}
              disabled={!profiles.length}
              options={[
                { value: "", label: githubCopy.none },
                ...githubLevels.map((value) => ({
                  value,
                  label: githubCopy.levels[value],
                })),
              ]}
              onChange={(level) =>
                set({
                  github: level
                    ? {
                        credentialId:
                          d.github?.credentialId || defaultGithubProfile(profiles)?.id,
                        level,
                      }
                    : null,
                })
              }
            />
            {d.github && profiles.length > 1 && (
              <SelectRow
                label={agentWizardCopy.access.githubProfile}
                value={d.github.credentialId}
                options={profiles.map((p) => ({ value: p.id, label: p.name }))}
                onChange={(credentialId) =>
                  set({ github: { ...d.github, credentialId } })
                }
              />
            )}
          </ListCard>
          {catalog && createButton("github", profiles.length)}
          {list(
            "secrets",
            copy.secrets,
            secrets,
            d.secretIds,
            "secretIds",
            copy.secretType,
          )}
        </>
      )}
      {creating && (
        <SetupSheet
          title={agentWizardCopy.access.create(sources[creating][0])}
          route={sources[creating][1]}
          onRefresh={load}
          onClose={() => setCreating("")}
        />
      )}
    </>
  );
}
