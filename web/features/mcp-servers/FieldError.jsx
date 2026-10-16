import React from "react";

/** A field's refusal, announced and referenced by the field's aria-describedby. */
export default function FieldError({ id, text }) {
  if (!text) return null;
  return (
    <small id={id} role="alert" className="mcp-field-error">
      {text}
    </small>
  );
}
