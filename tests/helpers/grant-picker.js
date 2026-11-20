// Drives the stacked GrantPicker (docs/ui-guide.md#choosing-what-a-session-may-use):
// its last row is an AddPicker combobox whose listbox offers the entries.

/**
 * Opens the combobox `fieldName` inside `scope`, types `optionName` and returns the
 * matching option, for assertions.
 */
export async function grantOption(scope, fieldName, optionName) {
  const field = scope.getByRole("combobox", { name: fieldName, exact: true });
  await field.click();
  await field.fill(optionName);
  return scope.getByRole("option", { name: optionName });
}

/** Adds `optionName` through the combobox `fieldName` inside `scope`. */
export async function addGrant(scope, fieldName, optionName) {
  const option = await grantOption(scope, fieldName, optionName);
  await option.click();
  await scope.getByRole("button", { name: /^(Add 1|1 hinzufügen)$/ }).click();
}
