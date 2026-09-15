import React, { createContext, useState } from "react";
import { createFileEditorStore } from "./file-editor-store.js";

export const FileEditorContext = createContext(null);
export function FileEditorProvider({ children }) {
  const [store] = useState(createFileEditorStore);
  return <FileEditorContext value={store}>{children}</FileEditorContext>;
}
