import React, { useEffect, useId, useRef, useState } from "react";
import Icon from "../../../components/Icon.jsx";
import { assistantBrowserCopy as copy } from "../../../lib/i18n/messages/assistant-browser.js";

/**
 * The browser toolbar above the live picture: back, forward, reload and stop, the
 * page address and, when the browser has more than one tab, the tab switcher.
 * While the viewer holds control (`controlling`) the buttons work, the address can
 * be edited (Enter opens it) and a tab can be switched to or closed in the agent's
 * browser; while only watching everything is read-only, and the tab choice only
 * picks the tab this view shows (`select`). The address and the tabs come from the
 * stream's state as the server pushes it.
 */
export default function BrowserToolbar({
  state,
  controlling,
  viewOnly,
  navigate,
  tab,
  select,
}) {
  const field = useRef(null);
  const tabField = useId();
  const [draft, setDraft] = useState(state.url || "");
  // While the owner types, the page's own address does not replace the text; a sent
  // address stays until the page reports its new one (or after an error, to fix it).
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(state.url || "");
  }, [state.url]);
  const submit = (event) => {
    event.preventDefault();
    if (!controlling || !draft.trim()) return;
    navigate({ action: "go", url: draft.trim() });
    editing.current = false;
    field.current?.blur();
  };
  const button = (action, icon, label) => (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      disabled={!controlling}
      onClick={() => navigate({ action })}
    >
      <Icon name={icon} />
    </button>
  );
  const tabs = state.tabs || [];
  return (
    <div className="agent-browser-toolbar" role="toolbar" aria-label={copy.liveToolbar}>
      <div className="agent-browser-toolbar-row">
        <div className="agent-browser-nav">
          {button("back", "back", copy.liveBack)}
          {button("forward", "arrow", copy.liveForward)}
          {button("reload", "refresh", copy.liveReload)}
          {button("stop", "stop", copy.liveStopLoading)}
        </div>
        <form className="agent-browser-address" onSubmit={submit}>
          <input
            ref={field}
            type="text"
            inputMode="url"
            enterKeyHint="go"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-label={copy.liveAddress}
            title={state.url || undefined}
            readOnly={!controlling}
            value={controlling ? draft : state.url || ""}
            onFocus={(event) => controlling && event.currentTarget.select()}
            onChange={(event) => {
              editing.current = true;
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // Escape drops the typed text and gives the page's address back.
              event.preventDefault();
              editing.current = false;
              setDraft(state.url || "");
            }}
          />
        </form>
      </div>
      {!viewOnly && tabs.length > 1 && (
        <div className="agent-browser-toolbar-row">
          <div className="agent-browser-tabs">
            <label htmlFor={tabField}>{copy.liveTab}</label>
            <select
              id={tabField}
              value={state.targetId || ""}
              onChange={(event) =>
                controlling
                  ? tab({ action: "switch", targetId: event.target.value })
                  : select(event.target.value)
              }
            >
              {tabs.map((one) => (
                <option key={one.targetId} value={one.targetId}>
                  {one.title || one.url || one.targetId}
                </option>
              ))}
            </select>
          </div>
          {controlling && state.targetId && (
            <button
              type="button"
              className="icon-button"
              aria-label={copy.liveCloseTab}
              title={copy.liveCloseTab}
              onClick={() => tab({ action: "close", targetId: state.targetId })}
            >
              <Icon name="close" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
