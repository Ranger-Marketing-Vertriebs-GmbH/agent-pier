export const paginationCopy = {
  listPaginationAriaLabel: (value1) => `${value1}: pages`,
  totalCountPrefix: " of ",
  previousPageLabel: (value1) => `${value1}: previous page`,
  pageNumberPrefix: "Page ",
  nextPageLabel: (value1) => `${value1}: next page`,
};
export const apiCopy = {
  requestFailed: (value1) => `Request failed (${value1})`,
};
export const imageViewerCopy = {
  title: "Image viewer",
  close: "Close image viewer",
  download: "Download",
  share: "Share",
  missing: "Image no longer available.",
};
export const fileLinkCopy = {
  failed: "The file could not be saved.",
  title: "Save file",
  tap: "Tap to save",
};
export const copyButtonCopy = {
  copied: "Copied",
  failed: "Copy failed. Select the text and copy it manually.",
};
export const addPickerCopy = {
  placeholder: (type) => `Add ${type} …`,
  fieldLabel: (type) => `Add ${type}`,
  listLabel: (type) => `${type}: options`,
  matches: (count) => (count === 1 ? "1 match" : `${count} matches`),
  noMatches: "No matches",
  searching: "Searching …",
  searchFailed: "The search failed. Change the text to try again.",
  alreadyGranted: "already granted",
  more: (count) => `${count} more – refine the search`,
  mode: "Mode",
  modeLabel: "Mode for new items",
  add: (count) => (count > 0 ? `Add ${count}` : "Add"),
};
