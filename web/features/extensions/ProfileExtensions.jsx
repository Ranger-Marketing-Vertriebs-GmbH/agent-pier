import { sharingCopy } from "../../lib/i18n/messages/sharing.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { profileExtensionsCopy as copy } from "../../lib/i18n/messages/extensions.js";
import React, { lazy, Suspense } from "react";
import { Pagination } from "../../components/Pagination.jsx";
import SkillInstallForm from "./SkillInstallForm.jsx";
import McpForm from "./McpForm.jsx";
import useProfileExtensions from "./useProfileExtensions.js";
const AgencyPanel = lazy(() => import("../agency/AgencyPanel.jsx"));
export default function ProfileExtensions({ account, request, setParentBusy }) {
  const {
    loading,
    loadError,
    setReload,
    error,
    notice,
    confirm,
    busy,
    setConfirm,
    mutate,
    endpoint,
    data,
    alive,
    skillQuery,
    setSkillQuery,
    skillPaging,
    skillSearch,
    setError,
  } = useProfileExtensions({
    account,
    request,
    setParentBusy,
  });
  if (loading)
    return (
      <p className="loading" role="status">
        {copy.extensionsLoading}
      </p>
    );
  if (loadError)
    return (
      <div className="extension-load-error">
        <ErrorMessage error={loadError} as="p" />
        <button
          className="button secondary"
          onClick={() => setReload((value) => value + 1)}
        >
          {commonCopy.reload}
        </button>
      </div>
    );
  if (!data) return null;
  return (
    <>
      {data.sharing && (
        <div className="form-note">
          <div>
            <p>{sharingCopy.description}</p>
            <button
              type="button"
              className="button secondary compact"
              disabled={Boolean(busy)}
              onClick={() =>
                mutate(
                  "share",
                  () => request(`${endpoint}/share`, "POST"),
                  sharingCopy.imported,
                )
              }
            >
              {sharingCopy.import}
            </button>
            {data.sharing.conflicts?.length > 0 && (
              <details>
                <summary>{sharingCopy.conflicts}</summary>
                <ul>
                  {data.sharing.conflicts.map((item, index) => (
                    <li key={`${item.accountId}:${index}`}>
                      <code>{item.file}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      )}
      {account.tool === "codex" && (
        <p className="extension-scope-note">{copy.extensionScopeNote}</p>
      )}
      {error && (
        <ErrorMessage error={error} as="p" className="error extension-feedback" />
      )}
      {notice && (
        <p className="extension-notice" role="status">
          {notice}
        </p>
      )}
      {confirm && (
        <div
          className="extension-confirm"
          role="group"
          aria-label={commonCopy.confirmRemoval}
        >
          <p>
            {confirm.kind === "mcp"
              ? copy.confirmMcpRemoval(confirm.name)
              : copy.confirmSkillRemoval(confirm.name)}
          </p>
          <div className="extension-actions">
            <button
              className="button secondary"
              disabled={Boolean(busy)}
              onClick={() => setConfirm(null)}
            >
              {commonCopy.cancel}
            </button>
            <button
              className="button danger"
              disabled={Boolean(busy)}
              onClick={() =>
                mutate(
                  "remove",
                  () =>
                    request(
                      `${endpoint}/${confirm.kind === "mcp" ? "mcp" : "skills"}/${encodeURIComponent(confirm.id)}`,
                      "DELETE",
                    ),
                  copy.removedNotice(confirm.name),
                )
              }
            >
              {commonCopy.confirmRemoval}
            </button>
          </div>
        </div>
      )}
      <section className="extension-section" aria-labelledby="mcp-heading">
        <div className="section-heading">
          <h2 id="mcp-heading">{copy.mcpHeading}</h2>
          <span>
            {data.mcp.servers.length}
            {copy.configuredCountSuffix}
          </span>
        </div>
        <p className="field-description">{data.mcp.note}</p>
        <code className="extension-path">{data.mcp.path}</code>
        <div className="extension-list">
          {data.mcp.servers.length ? (
            data.mcp.servers.map((server) => (
              <article className="extension-card" key={server.name}>
                <div className="extension-details">
                  <h3>{server.name}</h3>
                  <p>
                    {server.transport === "stdio"
                      ? copy.mcpCommandSummary(server.command, server.argumentCount)
                      : server.url || "Remote-MCP"}{" "}
                    · {server.enabled ? commonCopy.configured : commonCopy.disabled}
                  </p>
                  {(server.environmentKeys.length > 0 ||
                    server.headerKeys.length > 0) && (
                    <p>
                      {copy.savedValuesPrefix}
                      {server.environmentKeys.length} {copy.variableCountSuffix}
                      {server.headerKeys.length}
                      {copy.headerCountSuffix}
                    </p>
                  )}
                  <code className="extension-path">{server.source || data.mcp.path}</code>
                </div>
                <button
                  className="button secondary compact"
                  disabled={Boolean(busy)}
                  aria-label={commonCopy.removeMcpLabel(server.name)}
                  onClick={() =>
                    setConfirm({
                      kind: "mcp",
                      id: server.name,
                      name: server.name,
                    })
                  }
                >
                  {commonCopy.remove}
                </button>
              </article>
            ))
          ) : (
            <p className="extension-empty">{copy.noMcpServers}</p>
          )}
        </div>
        <McpForm
          {...{
            mutate,
            request,
            endpoint,
            alive,
            busy,
          }}
        />
      </section>
      <section className="extension-section" aria-labelledby="skills-heading">
        <div className="section-heading">
          <h2 id="skills-heading">{copy.skillsHeading}</h2>
          <span>
            {data.skills.items.length}
            {copy.skillsFoundSuffix}
          </span>
        </div>
        <p className="field-description">{data.skills.note}</p>
        <label>
          {commonCopy.searchSkills}
          <input
            type="search"
            value={skillQuery}
            onChange={(event) => setSkillQuery(event.target.value)}
            placeholder={copy.extensionSectionPlaceholder}
          />
        </label>
        <div className="extension-list">
          {skillPaging.items.length ? (
            skillPaging.items.map((skill) => (
              <article className="extension-card" key={skill.id}>
                <div className="extension-details">
                  <h3>{skill.name}</h3>
                  <p>{skill.description}</p>
                  <span className="extension-scope">
                    {skill.scope}
                    {skill.removable
                      ? commonCopy.installedHereSuffix
                      : copy.extensionScope}
                  </span>
                  <code className="extension-path">{skill.path}</code>
                </div>
                {skill.removable && (
                  <button
                    className="button secondary compact"
                    disabled={Boolean(busy)}
                    aria-label={commonCopy.removeSkillLabel(skill.name)}
                    onClick={() =>
                      setConfirm({
                        kind: "skill",
                        id: skill.id,
                        name: skill.name,
                      })
                    }
                  >
                    {commonCopy.remove}
                  </button>
                )}
              </article>
            ))
          ) : (
            <p className="extension-empty">
              {skillSearch ? copy.noMatchingSkills : copy.noSkills}
            </p>
          )}
        </div>
        <Pagination paging={skillPaging} label={copy.skillsHeading} />
        <SkillInstallForm
          {...{
            mutate,
            request,
            endpoint,
            alive,
            data,
            busy,
            setError,
          }}
        />
      </section>
      {account.shared && (
        <Suspense fallback={null}>
          <AgencyPanel
            account={account}
            request={request}
            setParentBusy={setParentBusy}
          />
        </Suspense>
      )}
    </>
  );
}
