import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import FileActions from "./FileActions.jsx";
import FileList from "./FileList.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";
import { explorerLayoutCopy as layout } from "../../lib/i18n/messages/explorer-layout.js";

export default function ExplorerListing({
  listing,
  title,
  toolbarTarget,
  scope,
  selection,
  clipboard,
  jobs,
  request,
  onRequestHandled,
  onRefresh,
  route,
  onOpen,
  onProperties,
  onPage,
  onAction,
  onDrag,
  onDrop,
}) {
  return (
    <div className="explorer-list-column">
      <FileActions
        key={`${scope.scopeId}:${scope.path}`}
        scope={scope}
        selection={selection}
        refreshing={listing.refreshing}
        clipboard={clipboard}
        jobs={jobs}
        onChanged={onRefresh}
        request={request}
        onRequestHandled={onRequestHandled}
        toolbarTarget={toolbarTarget}
      />
      <div className="explorer-folder-heading">
        <h2>{title}</h2>
        {listing.listing && <span>{layout.entries(listing.listing.total)}</span>}
      </div>
      {listing.loading && !listing.listing && <p role="status">{copy.loading}</p>}
      <ErrorMessage error={listing.error?.message} />
      {listing.error?.code === "FILE_SNAPSHOT_EXPIRED" && (
        <button className="button secondary compact" onClick={onRefresh}>
          {copy.refresh}
        </button>
      )}
      {listing.listing && (
        <>
          <FileList
            listing={listing.listing}
            selected={route.file}
            onOpen={onOpen}
            onProperties={onProperties}
            onPage={onPage}
            selection={selection}
            readOnly={scope.readOnly}
            onAction={onAction}
            onDrag={onDrag}
            onDrop={onDrop}
          />
          <p className="explorer-list-summary">
            {copy.summary(listing.listing.total, listing.listing.page)}
          </p>
        </>
      )}
    </div>
  );
}
