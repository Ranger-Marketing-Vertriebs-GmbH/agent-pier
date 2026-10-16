import React, { useId } from "react";

/**
 * One wizard screen: its single heading (focused on step change), the body and the
 * sticky bar. The body is a form, so Enter submits the primary action.
 */
export default function WizardStep({
  title,
  headingRef,
  children,
  primary,
  secondary,
  onSubmit,
  busy = false,
  titleTag: Title = "h1",
}) {
  const id = useId();
  return (
    <form
      id={id}
      className="mcp-wizard-step"
      aria-busy={busy || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSubmit?.();
      }}
    >
      <Title ref={headingRef} tabIndex={-1} className="mcp-wizard-title">
        {title}
      </Title>
      <div className="mcp-wizard-body">{children}</div>
      {(primary || secondary) && (
        <div className="mcp-wizard-bar">
          {primary && (
            <button
              type="submit"
              className="button primary"
              disabled={busy || primary.disabled}
              aria-describedby={primary.describedBy}
            >
              {primary.label}
            </button>
          )}
          {secondary && (
            <button
              type="button"
              className="button text"
              disabled={busy || secondary.disabled}
              onClick={secondary.onClick}
            >
              {secondary.label}
            </button>
          )}
        </div>
      )}
    </form>
  );
}
