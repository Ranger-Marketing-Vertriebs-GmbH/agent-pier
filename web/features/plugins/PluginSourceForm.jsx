import React, { useId } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import SidePanel from "../../components/SidePanel.jsx";

// Panel form for a single plugin source: a marketplace or an OpenCode npm package.
export default function PluginSourceForm({
  title,
  subtitle,
  label,
  placeholder,
  description,
  submitLabel,
  value,
  setValue,
  disabled,
  busy,
  error,
  close,
  submit,
}) {
  const formId = useId();
  return (
    <SidePanel
      title={title}
      subtitle={subtitle}
      close={close}
      closeDisabled={busy}
      footer={
        <button
          className="button primary"
          form={formId}
          disabled={disabled || !value.trim()}
        >
          {submitLabel}
        </button>
      }
    >
      <form
        id={formId}
        className="extension-panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset className="extension-fields" disabled={disabled}>
          <ErrorMessage error={error} as="p" className="error extension-wide" />
          <label className="extension-wide">
            {label}
            <input
              value={value}
              required
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <p className="field-description extension-wide">{description}</p>
        </fieldset>
      </form>
    </SidePanel>
  );
}
