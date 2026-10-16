/** One refused field per form: its message, and aria wiring for the field it names. */
export function fieldErrors(formId, fieldError) {
  const errorId = `${formId}-field-error`;
  const errorOf = (field) => (fieldError?.field === field ? fieldError.text : "");
  const describe = (field) =>
    errorOf(field) ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  return { errorId, errorOf, describe };
}
