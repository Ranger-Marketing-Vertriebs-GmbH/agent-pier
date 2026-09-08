import React, { useState } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { Pagination, usePagination } from "../../components/Pagination.jsx";
import SearchSelect from "../../components/SearchSelect.jsx";
import { agencyCopy as copy } from "../../lib/i18n/messages/agency.js";
import useAgency from "./useAgency.js";
import "./agency.css";

function AgencyBrowser(props) {
  const state = useAgency(props);
  const { data, preview, confirm, busy, loading, query, category, page } = state;
  const installed = usePagination(data?.installed || [], props.account.id);
  return (
    <div className="agency-browser">
      <p className="field-description">{copy.description}</p>
      <label>
        {copy.search}
        <input
          type="search"
          value={query}
          maxLength={200}
          onChange={(event) => {
            state.setQuery(event.target.value);
            state.setPage(1);
          }}
        />
      </label>
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
      {!preview && !confirm && <ErrorMessage error={state.error} />}
      {state.notice && <p role="status">{state.notice}</p>}
      {loading && <p role="status">{copy.loading}</p>}
      {data?.stale && <p role="status">{copy.stale}</p>}
      {!loading && data && (
        <>
          <p className="field-description">
            {copy.count(data.total, data.page)} · {copy.revision}:{" "}
            <code>{data.revision.slice(0, 8)}</code>
          </p>
          <div className="extension-list">
            {data.items.map((item) => (
              <article key={item.id} className="extension-card">
                <div className="extension-details">
                  <h3>{item.name}</h3>
                  <p>
                    {item.category}
                    {item.installed ? ` · ${copy.installed}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => state.show(item)}
                >
                  {copy.preview}
                </button>
              </article>
            ))}
          </div>
          {!data.items.length && <p>{copy.empty}</p>}
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
          {installed.total > 0 && (
            <section>
              <h3>{copy.installedTitle}</h3>
              {installed.items.map((item) => (
                <article className="extension-card" key={item.id}>
                  <div className="extension-details">
                    <strong>{item.name}</strong>
                    <p>
                      <a href={item.source} target="_blank" rel="noreferrer">
                        {copy.source}
                      </a>
                    </p>
                  </div>
                  <button
                    type="button"
                    className="button secondary compact"
                    disabled={busy}
                    onClick={() => state.setConfirm(item)}
                  >
                    {copy.remove}
                  </button>
                </article>
              ))}
              <Pagination paging={installed} label={copy.installedTitle} />
            </section>
          )}
        </>
      )}
      {preview && (
        <Modal
          title={preview.name}
          wide
          close={() => {
            if (!busy) state.setPreview(null);
          }}
          closeDisabled={busy}
        >
          <div className="form-content agency-preview">
            <p>{preview.description}</p>
            <p className="field-description">{copy.note}</p>
            <a href={preview.source} target="_blank" rel="noreferrer">
              {copy.source} · {preview.revision.slice(0, 8)}
            </a>
            <pre>{preview.body}</pre>
            <ErrorMessage error={state.error} />
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => state.setPreview(null)}
            >
              {copy.close}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy || data.installed.some((item) => item.id === preview.id)}
              onClick={state.install}
            >
              {data.installed.some((item) => item.id === preview.id)
                ? copy.installed
                : copy.install}
            </button>
          </div>
        </Modal>
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
export default function AgencyPanel(props) {
  const [open, setOpen] = useState(false),
    [working, setWorking] = useState(false);
  return (
    <section className="extension-section">
      <h2>
        <button
          type="button"
          className="agency-toggle"
          disabled={working}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {copy.title} <span aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
      </h2>
      {open && (
        <AgencyBrowser
          {...props}
          setParentBusy={(value) => {
            setWorking(value);
            props.setParentBusy(value);
          }}
        />
      )}
    </section>
  );
}
