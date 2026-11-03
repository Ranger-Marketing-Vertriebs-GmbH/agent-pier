// Size limits of native question previews and notes; a leaf so validation and the
// question view can share them without importing each other.

// The chat shows previews as plain text; longer previews are cut to keep requests bounded.
export const previewLimit = 8000;
export const notesLimit = 8000;
