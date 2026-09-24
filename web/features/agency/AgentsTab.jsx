import React, { useEffect } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { Pagination, usePagination } from "../../components/Pagination.jsx";
import SearchSelect from "../../components/SearchSelect.jsx";
import Segment from "../../components/Segment.jsx";
import SidePanel from "../../components/SidePanel.jsx";
import { agencyCopy as copy } from "../../lib/i18n/messages/agency.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { names } from "../../lib/providers.js";
import ExtensionTable, { ExtensionHint } from "../extensions/ExtensionTable.jsx";
import useAgency from "./useAgency.js";
import "./agency.css";

// Mounted the first time the Agenten tab opens and kept afterwards, so the
// catalog is only fetched on demand and notices survive tab switches.
export default function AgentsTab({ mode, setMode, onCount, ...props }) {
  const state = useAgency(props);
  const { data, preview, confirm, busy, loading, query, category, page } = state;
  const installed = usePagination(data?.installed || [], props.account.id);
  const installedCount = data?.installed.length;
  useEffect(() => onCount(installedCount), [installedCount, onCount]);
  const catalog = mode === "catalog";
  const isInstalled = (id) => data?.installed.some((item) => item.id === id);
  return (
    <div className="agency-browser">
      <div className="extension-toolbar">
        {catalog && (
          <input
            type="search"
            aria-label={copy.search}
            placeholder={copy.search}
            value={query}
            maxLength={200}
            onChange={(event) => {
              state.setQuery(event.target.value);
              state.setPage(1);
            }}
          />
        )}
        <Segment
          label={hub.viewLabel}
          className="extension-mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "installed", label: hub.installedView(installedCount ?? 0) },
            { value: "catalog", label: copy.catalogView(data?.total ?? 0) },
          ]}
        />
      </div>
      <ExtensionHint>
        <p>{copy.description}</p>
        <p>{copy.scope}</p>
      </ExtensionHint>
      {catalog && (
        <div className="agency-filters">
          <SearchSelect
            label={copy.category}
            searchLabel={copy.category}
            value={category}
            options={[
              { value: "", label: copy.all },
              ...(data?.categories || []).map((value) => ({ value, label: value })),
            ]}
            onChange={(value) => {
              state.setCategory(value);
              state.setPage(1);
            }}
          />
          <button
            type="button"
            className="button secondary compact"
            disabled={busy || loading}
            onClick={state.refresh}
          >
            {copy.refresh}
          </button>
        </div>
      )}
      {!preview && !confirm && <ErrorMessage error={state.error} />}
      {state.notice && (
        <p className="extension-notice" role="status">
          {state.notice}
        </p>
      )}
      {loading && <p role="status">{copy.loading}</p>}
      {data?.stale && <p role="status">{copy.stale}</p>}
      {!loading && data && catalog && (
        <>
          <p className="field-description">
            {copy.count(data.total, data.page)} · {copy.revision}:{" "}
            <code>{data.revision.slice(0, 8)}</code>
          </p>
          <ExtensionTable
            heads={[hub.headAgent, copy.category, hub.headStatus]}
            empty={copy.empty}
            rows={data.items.map((item) => ({
              key: item.id,
              name: item.name,
              tag: item.category,
              status: {
                on: Boolean(item.installed),
                text: item.installed ? copy.installed : hub.available,
              },
              actions: (
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => state.show(item)}
                >
                  {copy.preview}
                </button>
              ),
            }))}
          />
          {(page > 1 || data.hasMore) && (
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary compact"
                disabled={busy || page === 1}
                onClick={() => state.setPage(page - 1)}
              >
                {copy.back}
              </button>
              <button
                type="button"
                className="button secondary compact"
                disabled={busy || !data.hasMore}
                onClick={() => state.setPage(page + 1)}
              >
                {copy.next}
              </button>
            </div>
          )}
        </>
      )}
      {data && !catalog && (
        <>
          <ExtensionTable
            heads={[hub.headAgent, copy.revision, ""]}
            empty={copy.noInstalled}
            rows={installed.items.map((item) => ({
              key: item.id,
              name: item.name,
              details: (
                <p>
                  <a href={item.source} target="_blank" rel="noreferrer">
                    {copy.source}
                  </a>
                </p>
              ),
              tag: item.revision?.slice(0, 8),
              actions: (
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => state.setConfirm(item)}
                >
                  {copy.remove}
                </button>
              ),
            }))}
          />
          <Pagination paging={installed} label={copy.installedTitle} />
        </>
      )}
      {preview && (
        <SidePanel
          title={preview.name}
          subtitle={copy.appliesTo(names[props.account.tool] || props.account.tool)}
          close={() => {
            if (!busy) state.setPreview(null);
          }}
          closeDisabled={busy}
          cancelLabel={copy.close}
          footer={
            <button
              type="button"
              className="button primary"
              disabled={busy || isInstalled(preview.id)}
              onClick={state.install}
            >
              {isInstalled(preview.id) ? copy.installed : copy.install}
            </button>
          }
        >
          <div className="agency-preview">
            <p>{preview.description}</p>
            <p className="field-description">{copy.note}</p>
            <a href={preview.source} target="_blank" rel="noreferrer">
              {copy.source} · {preview.revision.slice(0, 8)}
            </a>
            <pre>{preview.body}</pre>
            <ErrorMessage error={state.error} />
          </div>
        </SidePanel>
      )}
      {confirm && (
        <Modal
          title={copy.remove}
          close={() => {
            if (!busy) state.setConfirm(null);
          }}
          closeDisabled={busy}
        >
          <div className="form-content">
            <p>{copy.removal}</p>
            <strong>{confirm.name}</strong>
            <ErrorMessage error={state.error} />
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => state.setConfirm(null)}
            >
              {copy.cancel}
            </button>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={state.remove}
            >
              {copy.remove}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
