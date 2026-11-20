import React, { useLayoutEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { editorHighlighting } from "../../components/editor-highlight.js";
import { fileEditorCopy as copy } from "../../lib/i18n/messages/file-editor.js";

const readOnly = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorView.theme({}, { dark: true }),
  editorHighlighting(),
];

export default function FileEditorConflict({
  draft,
  current,
  onUseCurrent,
  onResolve,
  onReplace,
}) {
  const host = useRef(null);
  useLayoutEffect(() => {
    const merge = new MergeView({
      a: { doc: draft.text, extensions: readOnly },
      b: { doc: current.text, extensions: readOnly },
      parent: host.current,
      highlightChanges: true,
      gutter: true,
    });
    return () => merge.destroy();
  }, [current.text, draft.text]);
  return (
    <section
      className="file-editor-conflict"
      role="region"
      aria-label={copy.conflictTitle}
    >
      <h3>{copy.conflictTitle}</h3>
      <div className="file-editor-conflict-labels" aria-hidden="true">
        <span>{copy.conflictDraft}</span>
        <span>{copy.conflictCurrent}</span>
      </div>
      <div ref={host} />
      <div className="file-editor-toolbar">
        <button onClick={onUseCurrent}>{copy.useCurrent}</button>
        <button onClick={onResolve}>{copy.resolveManually}</button>
        <button onClick={onReplace}>{copy.replaceCurrent}</button>
      </div>
    </section>
  );
}
