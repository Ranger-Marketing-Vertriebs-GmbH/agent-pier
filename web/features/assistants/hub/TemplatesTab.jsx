import React, { useEffect, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../../components/ListRow.jsx";
import SearchSelect from "../../../components/SearchSelect.jsx";
import SidePanel from "../../../components/SidePanel.jsx";
import { routePath } from "../../../app/routes.js";
import { agentTemplateCopy } from "../../../lib/i18n/messages/agent-templates.js";
import { agencyCopy } from "../../../lib/i18n/messages/agency.js";
import { agentsHubCopy } from "../../../lib/i18n/messages/agents-hub.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { assistantApi } from "../assistant-api.js";
import TemplateNote from "../settings/TemplateNote.jsx";
import { subagentInstallRoute, templateAgentRoute } from "./hub-model.js";
import "../../agency/agency.css";

const copy = () => agentsHubCopy.templates;

function useCatalog() {
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [page, setPage] = useState(1),
    [reload, setReload] = useState(0),
    [data, setData] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      assistantApi
        .templates({ q: query.toLowerCase(), category, page }, controller.signal)
        .then((result) => !controller.signal.aborted && setData(result))
        .catch((e) => !controller.signal.aborted && setError(e.message))
        .finally(() => !controller.signal.aborted && setLoading(false));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, category, page, reload]);
  return {
    query,
    category,
    page,
    data,
    loading,
    error,
    setError,
    search: (value) => {
      setQuery(value);
      setPage(1);
    },
    filter: (value) => {
      setCategory(value);
      setPage(1);
    },
    setPage,
    reloaded: () => setReload((n) => n + 1),
  };
}

function link(route, navigate) {
  return {
    href: routePath(route),
    onClick: (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
      event.preventDefault();
      navigate(route);
    },
  };
}

/**
 * One entry's preview: description, scan verdict, source, revision and license.
 * Installing as a subagent needs a shared CLI profile (Coding › Unteragenten exists
 * only then); without one the action is disabled and says why.
 */
function TemplatePreview({ preview, onClose, navigate, subagentProfiles }) {
  const blocked = preview.verdict === "block";
  return (
    <SidePanel
      title={preview.name}
      subtitle={preview.category}
      close={onClose}
      cancelLabel={agentTemplateCopy.close}
      footer={
        blocked ? null : (
          <>
            {subagentProfiles ? (
              <a
                className="button secondary"
                {...link(subagentInstallRoute(preview), navigate)}
              >
                {copy().installSubagent}
              </a>
            ) : (
              <button
                type="button"
                className="button secondary"
                disabled
                aria-describedby={
                  subagentProfiles === false ? "template-subagent-reason" : undefined
                }
              >
                {copy().installSubagent}
              </button>
            )}
            <a
              className="button primary"
              {...link(templateAgentRoute(preview), navigate)}
            >
              {copy().createAgent}
            </a>
          </>
        )
      }
    >
      <div className="agency-preview agent-template-preview">
        <p>{preview.description}</p>
        <ListCard label={copy().preview}>
          <ListRow
            label={copy().scan}
            value={copy().verdicts[preview.verdict] ?? unknownValue}
          />
        </ListCard>
        <TemplateNote template={preview} findings={preview.findings} />
        {blocked && <ErrorMessage error={copy().blocked} />}
        {!blocked && subagentProfiles === false && (
          <p className="field-description" id="template-subagent-reason">
            {copy().noSubagentProfiles}
          </p>
        )}
        <p className="field-description">{copy().installedNote}</p>
        <pre>{preview.instructions}</pre>
      </div>
    </SidePanel>
  );
}

/**
 * Vorlagen (handoff 5.2): the Agency catalog moved from Erweiterungen › Agenten,
 * with search, Kategorie, "Katalog aktualisieren" and paging. A preview offers
 * "Persönlichen Agenten anlegen" and "Als Unteragent in CLI installieren …";
 * a blocked entry offers neither.
 */
export default function TemplatesTab({ navigate, onTotal, subagentProfiles = null }) {
  const catalog = useCatalog();
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data, page } = catalog;
  const total = data?.total;
  useEffect(() => {
    if (Number.isSafeInteger(total)) onTotal?.(total);
  }, [total, onTotal]);
  const show = async (item) => {
    setBusy(true);
    catalog.setError("");
    try {
      setPreview(await assistantApi.template(item.id, data.revision));
    } catch (e) {
      catalog.setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    catalog.setError("");
    try {
      await assistantApi.templates({ refresh: true });
      catalog.reloaded();
    } catch (e) {
      catalog.setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="agency-browser agents-hub-templates">
      <div className="agents-hub-toolbar">
        <input
          type="search"
          aria-label={copy().search}
          placeholder={copy().search}
          value={catalog.query}
          maxLength={200}
          onChange={(event) => catalog.search(event.target.value)}
        />
        <SearchSelect
          label={agentTemplateCopy.category}
          searchLabel={agentTemplateCopy.category}
          value={catalog.category}
          options={[
            { value: "", label: agentTemplateCopy.all },
            ...(data?.categories || []).map((value) => ({ value, label: value })),
          ]}
          onChange={catalog.filter}
        />
        <button
          type="button"
          className="button secondary compact"
          disabled={busy || catalog.loading}
          onClick={refresh}
        >
          {agencyCopy.refresh}
        </button>
      </div>
      <p className="field-description">{copy().hint}</p>
      {!preview && <ErrorMessage error={catalog.error} />}
      {catalog.loading && <p role="status">{agentTemplateCopy.loading}</p>}
      {data?.stale && <p role="status">{agencyCopy.stale}</p>}
      {!catalog.loading && data && (
        <>
          <p className="field-description">
            {copy().catalog(data.total)} · {copy().page(data.page)}
          </p>
          {data.items.length ? (
            <ListCard label={copy().catalog(data.total)}>
              {data.items.map((item) => (
                <ListRow
                  key={item.id}
                  label={item.name}
                  sub={item.category}
                  disabled={busy}
                  onClick={() => show(item)}
                />
              ))}
            </ListCard>
          ) : (
            <p className="extension-empty">{agentTemplateCopy.empty}</p>
          )}
          {(page > 1 || data.hasMore) && (
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary compact"
                disabled={busy || page === 1}
                onClick={() => catalog.setPage(page - 1)}
              >
                {commonCopy.back}
              </button>
              <button
                type="button"
                className="button secondary compact"
                disabled={busy || !data.hasMore}
                onClick={() => catalog.setPage(page + 1)}
              >
                {agentTemplateCopy.next}
              </button>
            </div>
          )}
        </>
      )}
      {preview && (
        <TemplatePreview
          preview={preview}
          navigate={navigate}
          subagentProfiles={subagentProfiles}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
