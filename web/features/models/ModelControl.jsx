import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { modelControlCopy as copy } from "../../lib/i18n/messages/models.js";
import React from "react";
import SessionProviderConfiguration from "../providers/SessionProviderConfiguration.jsx";
import useModelControl from "./useModelControl.js";
export default function ModelControl({
  session,
  active,
  request,
  openTerminal,
  onPendingChange,
  blocked = false,
}) {
  const {
    state,
    trigger,
    visible,
    panelId,
    busy,
    picker,
    setExpanded,
    mutate,
    error,
    panel,
    availableHeight,
    cancel,
    query,
    setQuery,
  } = useModelControl({
    session,
    active,
    request,
    openTerminal,
    onPendingChange,
  });
  const configuration = state.configuration || session.provider;
  const requiresRestart = Boolean(
    state.modelChangeRequiresRestart || configuration?.modelChangeRequiresRestart,
  );
  return (
    <div className="model-control">
      <SessionProviderConfiguration
        configuration={configuration}
        requiresRestart={requiresRestart}
        tool={session.tool}
      />
      <div className="model-field">
        <span className="model-caption">
          {state.currentSource === "confirmed" ? copy.modelCaption : commonCopy.model}
        </span>
        <button
          ref={trigger}
          type="button"
          className="model-trigger"
          aria-label={copy.modelTriggerAriaLabel}
          aria-haspopup="dialog"
          aria-expanded={visible}
          aria-controls={visible ? panelId : undefined}
          disabled={
            blocked ||
            session.pipeline?.headless ||
            busy ||
            session.status !== "running" ||
            (requiresRestart && !picker && !state.pending)
          }
          onClick={() => (picker || state.pending ? setExpanded(true) : mutate("open"))}
        >
          <span>{state.currentModel || copy.modelTriggerAriaLabel}</span>
          <span aria-hidden="true">⌃</span>
        </button>
        {busy && (
          <span className="model-working" role="status">
            {copy.modelWorking}
          </span>
        )}
      </div>
      {error && !visible && <ErrorMessage error={error} as="p" className="model-error" />}
      {visible && (
        <div
          ref={panel}
          id={panelId}
          className="model-popover"
          style={{
            "--model-available-height": `${availableHeight}px`,
          }}
          role="dialog"
          aria-label={copy.modelPopoverAriaLabel}
          aria-busy={busy}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !blocked) {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
        >
          <div className="model-heading">
            <strong>{picker?.title || commonCopy.modelPicker}</strong>
            {!picker && !state.pending && (
              <button
                type="button"
                className="model-close"
                aria-label={copy.modelCloseAriaLabel}
                disabled={blocked || busy}
                onClick={cancel}
              >
                ×
              </button>
            )}
          </div>
          {picker?.kind === "effort" && (
            <p className="model-hint">{copy.reasoningSelectionHint}</p>
          )}
          {picker?.searchable && (
            <form
              className="model-search"
              onSubmit={(event) => {
                event.preventDefault();
                mutate("search", {
                  token: picker.token,
                  query,
                });
              }}
            >
              <input
                aria-label={copy.modelSearchAriaLabel}
                placeholder={copy.modelSearchPlaceholder}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                disabled={
                  blocked || session.pipeline?.headless || busy || requiresRestart
                }
              />
              <button
                type="submit"
                disabled={
                  blocked || session.pipeline?.headless || busy || requiresRestart
                }
              >
                {copy.modelSearchButton}
              </button>
            </form>
          )}
          {picker && (
            <div
              className="model-options"
              role="group"
              aria-label={
                picker.kind === "effort" ? commonCopy.reasoningLevels : commonCopy.models
              }
            >
              {picker.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="model-option"
                  aria-label={option.label}
                  data-selected={picker.selected === option.id}
                  disabled={
                    blocked || session.pipeline?.headless || busy || requiresRestart
                  }
                  onClick={() =>
                    mutate("select", {
                      token: picker.token,
                      optionId: option.id,
                    })
                  }
                >
                  <span className="model-option-label">
                    {option.label}
                    {option.current && <small>{copy.modelOptionLabelHint}</small>}
                  </span>
                  {option.description && (
                    <span className="model-option-description">{option.description}</span>
                  )}
                </button>
              ))}
              {!picker.options.length && (
                <p className="model-hint">{copy.noMatchingModels}</p>
              )}
            </div>
          )}
          {state.notice && (
            <p className="model-hint" role="status">
              {state.notice}
            </p>
          )}
          {!picker && !state.notice && !busy && !error && (
            <p className="model-hint">{copy.terminalSelectionHint}</p>
          )}
          {error && <ErrorMessage error={error} as="p" className="model-error" />}
          <div className="model-actions">
            {picker?.token && (
              <button type="button" disabled={blocked || busy} onClick={cancel}>
                {copy.cancelSelection}
              </button>
            )}
            <button type="button" onClick={openTerminal}>
              {copy.continueInTerminal}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
