// Locators for the tabbed agent settings page (settings pattern).
export const agentTab = (page, name) => page.getByRole("tab", { name, exact: true });
export const saveBar = (page, name = "Unsaved changes") =>
  page.getByRole("region", { name });
export const unsavedSheet = (page, name = "Save changes?") =>
  page.getByRole("dialog", { name });
export function settingsPath(tab, subpage, id = "home") {
  const query = new URLSearchParams();
  if (tab) query.set("tab", tab);
  if (subpage) query.set("page", subpage);
  const search = query.toString();
  return `/agents/${id}/settings${search ? `?${search}` : ""}`;
}
// What a real unload would do: the page holds the warning while a draft is dirty.
export const beforeUnloadPrevented = (page) =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
