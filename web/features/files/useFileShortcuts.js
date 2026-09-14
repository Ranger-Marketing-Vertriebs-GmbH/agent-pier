import { useCallback, useRef } from "react";

const editableTarget = (target) =>
  target instanceof Element &&
  Boolean(
    target.closest(
      "input:not([type='checkbox']):not([type='radio']), textarea, select, [contenteditable='true']",
    ),
  );

export default function useFileShortcuts({
  selection,
  clipboard,
  actions,
  editorFocused,
}) {
  return useCallback(
    (event) => {
      if (
        event.defaultPrevented ||
        editableTarget(event.target) ||
        (typeof editorFocused === "function"
          ? editorFocused(event.target)
          : editorFocused) ||
        event.target.closest("dialog") ||
        !event.currentTarget.contains(document.activeElement)
      )
        return;
      const key = event.key.toLowerCase();
      const command = event.metaKey || event.ctrlKey;
      if (command && key === "a") {
        event.preventDefault();
        selection.selectAll();
      } else if (command && ["c", "x", "v"].includes(key)) {
        event.preventDefault();
        actions.request(
          key === "v" ? "paste" : key === "c" ? "copy" : "cut",
          key === "v" ? clipboard.items : selection.selected,
          event.target,
        );
      } else if (event.key === "Delete" && selection.selected.length) {
        event.preventDefault();
        actions.request("trash", selection.selected, event.target);
      } else if (event.key === "F2" && selection.selected.length === 1) {
        event.preventDefault();
        actions.request("rename", selection.selected, event.target);
      } else if (event.key === "Escape") {
        selection.clear();
      } else if (
        event.key === "Enter" &&
        selection.selected.length === 1 &&
        !event.target.closest("button, a, input, select, textarea, [role='menuitem']")
      ) {
        event.preventDefault();
        actions.open(selection.selected[0]);
      }
    },
    [actions, clipboard.items, editorFocused, selection],
  );
}

export function useExplorerFileShortcuts(selection, clipboard, request, open) {
  return useFileShortcuts({
    selection,
    clipboard,
    actions: {
      request,
      open,
    },
    editorFocused: (target) => Boolean(target?.closest?.(".file-editor")),
  });
}

export function useOwnedListAction(owner, setRequest) {
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  return useCallback(
    (kind, items, origin) =>
      setRequest({
        owner,
        kind,
        items,
        restoreFocus: () => {
          if (currentOwner.current !== owner) return;
          const active = document.activeElement;
          if (
            active !== document.body &&
            active?.isConnected &&
            !active.closest?.("dialog")
          )
            return;
          if (origin?.isConnected) origin.focus();
          else
            document
              .querySelector(
                ".explorer-list .file-selection-checkbox, .explorer-list button",
              )
              ?.focus();
        },
      }),
    [owner, setRequest],
  );
}
