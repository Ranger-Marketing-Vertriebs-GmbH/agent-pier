import React, { useLayoutEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
  bracketMatching,
} from "@codemirror/language";
import { loadLanguage } from "./file-editor-languages.js";
import { fileEditorCopy as copy } from "../../lib/i18n/messages/file-editor.js";
import useLanguage from "../../lib/i18n/useLanguage.js";
import "./file-editor.css";

const language = new Compartment();
const phrases = new Compartment();
const permissions = new Compartment();
const attributes = new Compartment();
const shortcuts = new Compartment();
export default function FileEditor({ tab, onChange: edit, onSave: save, searchRef }) {
  const locale = useLanguage();
  const host = useRef(null);
  const mounted = useRef(null);
  const pendingScroll = useRef(null);
  const callbacks = useRef({ edit, save });
  useLayoutEffect(() => {
    callbacks.current = { edit, save };
  });
  useLayoutEffect(() => {
    const id = tab.id;
    const state =
      tab.editorState ||
      EditorState.create({
        doc: tab.text,
        extensions: [
          EditorView.theme({}, { dark: true }),
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          bracketMatching(),
          search({ top: true }),
          syntaxHighlighting(defaultHighlightStyle),
          language.of([]),
          phrases.of(EditorState.phrases.of({})),
          permissions.of([]),
          attributes.of([]),
          shortcuts.of([]),
        ],
      });
    const view = new EditorView({
      state,
      parent: host.current,
      scrollTo: tab.scrollSnapshot,
      dispatchTransactions(transactions, current) {
        current.update(transactions);
        callbacks.current.edit(id, {
          text: current.state.doc.toString(),
          editorState: current.state,
          scrollTop: current.scrollDOM.scrollTop,
          scrollSnapshot: current.scrollSnapshot(),
        });
      },
    });
    mounted.current = view;
    pendingScroll.current = tab.scrollSnapshot;
    view.dispatch({
      effects: shortcuts.reconfigure(
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              callbacks.current.save(id);
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
      ),
    });
    const scroll = () =>
      callbacks.current.edit(id, {
        editorState: view.state,
        scrollTop: view.scrollDOM.scrollTop,
        scrollSnapshot: view.scrollSnapshot(),
      });
    view.scrollDOM.addEventListener("scroll", scroll);

    searchRef.current = () => {
      openSearchPanel(view);
      view.focus();
    };
    let live = true;
    loadLanguage(tab.path)
      .then((extension) => {
        if (live) view.dispatch({ effects: language.reconfigure(extension) });
      })
      .catch(() => {});
    return () => {
      live = false;
      scroll();
      view.scrollDOM.removeEventListener("scroll", scroll);
      mounted.current = null;
      searchRef.current = null;
      view.destroy();
    };
    // The retained EditorState belongs to this tab incarnation, not to a render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);
  useLayoutEffect(() => {
    const view = mounted.current;
    if (!view) return;
    const snapshot = pendingScroll.current ?? view.scrollSnapshot();
    pendingScroll.current = null;
    // CodeMirror resets the view when phrases change. Reapply its own snapshot
    // after that reset so tab activation and locale changes retain the viewport.
    view.dispatch({
      effects: [
        phrases.reconfigure(
          EditorState.phrases.of({
            Find: copy.find,
            Replace: copy.replace,
            next: copy.next,
            previous: copy.previous,
            all: copy.all,
            "match case": copy.matchCase,
            regexp: copy.regexp,
            "by word": copy.byWord,
            replace: copy.replaceAction,
            "replace all": copy.replaceAll,
            close: copy.closeSearch,
            Search: copy.search,
            "Go to line": copy.goToLine,
            go: copy.go,
            "current match": copy.currentMatch,
            "on line": copy.onLine,
            "replaced match on line $": copy.replacedLine,
            "replaced $ matches": copy.replacedMatches,
          }),
        ),
        permissions.reconfigure([
          EditorState.readOnly.of(
            tab.document.readOnly || tab.format.lineEnding === "mixed",
          ),
          EditorView.editable.of(
            !tab.document.readOnly && tab.format.lineEnding !== "mixed",
          ),
        ]),
        attributes.reconfigure(
          EditorView.contentAttributes.of({
            "aria-label": copy.editorLabel(tab.path),
            spellcheck: "false",
            autocapitalize: "off",
            autocorrect: "off",
          }),
        ),
      ],
    });
    view.dispatch({ effects: snapshot });
  }, [locale, tab.id, tab.document.readOnly, tab.format.lineEnding, tab.path]);
  return <div className="file-editor-view" ref={host} />;
}
