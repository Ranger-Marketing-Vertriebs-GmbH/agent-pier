import React, { useId, useLayoutEffect } from "react";
import SaveBar from "../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";

// One entry's subpage: a region named by its title, its groups, the destructive
// action at the bottom and the save bar.
export default function AccountDetail({
  title,
  className = "",
  destructive,
  bar,
  children,
}) {
  const id = useId();
  return (
    <section
      className={["accounts-detail", className].filter(Boolean).join(" ")}
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className="accounts-detail-title">
        {title}
      </h2>
      {children}
      {destructive && <div className="accounts-detail-danger">{destructive}</div>}
      {bar}
    </section>
  );
}

export function AccountSaveBar({
  form,
  draft = form.draft,
  formRef,
  saveLabel,
  note,
  saveDisabled = false,
  saveFocusKey,
}) {
  // Every save path (bar, Enter, overwrite, "Save and switch") asks this first, so a
  // form that is not savable shows its inline reason instead of a server error.
  const { gate } = form;
  useLayoutEffect(() => {
    if (!gate) return undefined;
    gate.current = () =>
      !saveDisabled && (!formRef?.current || formRef.current.reportValidity());
    return () => {
      gate.current = null;
    };
  }, [gate, formRef, saveDisabled]);
  return (
    <>
      <SaveBar
        draft={draft}
        onSave={form.save}
        onOverwrite={form.overwrite}
        saveLabel={saveLabel}
        note={note}
        saveDisabled={saveDisabled}
        saveFocusKey={saveFocusKey}
      />
      <UnsavedChangesSheet {...form.sheet} />
    </>
  );
}
