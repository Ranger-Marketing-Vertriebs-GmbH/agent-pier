import React, { useEffect, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import SearchSelect from "../../../components/SearchSelect.jsx";
import SidePanel from "../../../components/SidePanel.jsx";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { agentTemplateCopy as copy } from "../../../lib/i18n/messages/agent-templates.js";
import { assistantApi } from "../assistant-api.js";
import TemplateNote from "./TemplateNote.jsx";
import "../../agency/agency.css";

/**
 * "Start from a template": the Agency catalog to search, one entry's preview with
 * its scan, and "Use template" for an entry the scan did not block.
 */
export default function TemplatePicker({ onUse, onClose }) {
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [page, setPage] = useState(1),
    [data, setData] = useState(null),
    [loading, setLoading] = useState(true),
    [preview, setPreview] = useState(null),
    [busy, setBusy] = useState(false),
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
  }, [query, category, page]);
  const show = async (item) => {
    setBusy(true);
    setError("");
    try {
      setPreview(await assistantApi.template(item.id, data.revision));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (preview)
    return (
      <SidePanel
        title={preview.name}
        subtitle={preview.category}
        close={() => setPreview(null)}
        cancelLabel={copy.back}
        footer={
          <button
            type="button"
            className="button primary"
            disabled={preview.verdict === "block"}
            onClick={() => onUse(preview)}
          >
            {copy.use}
          </button>
        }
      >
        <div className="agency-preview agent-template-preview">
          <p>{preview.description}</p>
          <p className="field-description">{copy.note}</p>
          <TemplateNote template={preview} findings={preview.findings} />
          <pre>{preview.instructions}</pre>
        </div>
      </SidePanel>
    );
  return (
    <SidePanel
      title={copy.pickerTitle}
      subtitle={copy.pickerSubtitle}
      close={onClose}
      closeDisabled={busy}
      cancelLabel={copy.close}
    >
      <div className="agency-browser">
        <input
          type="search"
          aria-label={copy.search}
          placeholder={copy.search}
          value={query}
          maxLength={200}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
        <SearchSelect
          label={copy.category}
          searchLabel={copy.category}
          value={category}
          options={[
            { value: "", label: copy.all },
            ...(data?.categories || []).map((value) => ({ value, label: value })),
          ]}
          onChange={(value) => {
            setCategory(value);
            setPage(1);
          }}
        />
        <ErrorMessage error={error} />
        {loading && <p role="status">{copy.loading}</p>}
        {!loading && data && (
          <>
            <p className="field-description">{copy.count(data.total, data.page)}</p>
            {data.items.length ? (
              <ListCard label={copy.pickerTitle}>
                {data.items.map((item) => (
                  <ListRow key={item.id} label={item.name} sub={item.category}>
                    <button
                      type="button"
                      className="button secondary compact"
                      disabled={busy}
                      onClick={() => show(item)}
                    >
                      {copy.preview}
                    </button>
                  </ListRow>
                ))}
              </ListCard>
            ) : (
              <p className="extension-empty">{copy.empty}</p>
            )}
            {(page > 1 || data.hasMore) && (
              <div className="dialog-actions">
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={busy || page === 1}
                  onClick={() => setPage(page - 1)}
                >
                  {commonCopy.back}
                </button>
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={busy || !data.hasMore}
                  onClick={() => setPage(page + 1)}
                >
                  {copy.next}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </SidePanel>
  );
}
