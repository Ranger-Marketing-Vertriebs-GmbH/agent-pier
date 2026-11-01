import React, { useCallback, useId, useMemo } from "react";
import { FileEditorProvider } from "../files/file-editor-context.jsx";
import useFileNavigationGuard from "../files/useFileNavigationGuard.js";
import FileNavigationGuardDialog from "../files/FileNavigationGuardDialog.jsx";
import { PaneContext } from "../../lib/pane-context.js";
import { requestNavigation } from "../../lib/navigation-guard.js";
import SessionPane from "./SessionPane.jsx";
import ChatPane from "./ChatPane.jsx";

const noHeaderProps = Object.freeze({});

/**
 * One pane of a split view: its own editor store and unsaved-edits guard, so leaving
 * the view or closing the pane asks only about this pane's documents, and its own
 * PaneContext (size, focus, id prefix) for the session or chat inside.
 */
export default function PaneHost(props) {
  return (
    <FileEditorProvider>
      <PaneFrame {...props} />
    </FileEditorProvider>
  );
}

function PaneFrame({ pane, size, focused, flash, actions, onFocusPane, shared }) {
  const reactId = useId();
  const idPrefix = `pane${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const guard = useFileNavigationGuard({ scope: pane.key });
  const context = useMemo(
    () => ({ key: pane.key, focused, width: size.width, height: size.height, idPrefix }),
    [pane.key, focused, size.width, size.height, idPrefix],
  );
  // Navigations inside the pane ask only about this pane's unsaved documents.
  const request = useCallback(
    (next, commit) =>
      requestNavigation({ reason: "application", paneScope: pane.key, next, commit }),
    [pane.key],
  );
  const close = useCallback(
    () =>
      requestNavigation({
        reason: "pane-close",
        paneScope: pane.key,
        commit: () => actions.remove(pane.key),
      }),
    [actions, pane.key],
  );
  const chrome = useMemo(() => ({ close, headerProps: noHeaderProps }), [close]);
  const focus = () => onFocusPane(pane.key);
  return (
    <PaneContext.Provider value={context}>
      <div
        className={`split-pane-host${focused ? " split-pane-focused" : ""}${flash ? " split-pane-flash" : ""}`}
        tabIndex={-1}
        onFocus={focus}
        onPointerDown={focus}
      >
        {pane.item.kind === "session" ? (
          <SessionPane
            pane={pane}
            actions={actions}
            request={request}
            chrome={chrome}
            {...shared}
          />
        ) : (
          <ChatPane pane={pane} actions={actions} chrome={chrome} />
        )}
      </div>
      <FileNavigationGuardDialog guard={guard} />
    </PaneContext.Provider>
  );
}
