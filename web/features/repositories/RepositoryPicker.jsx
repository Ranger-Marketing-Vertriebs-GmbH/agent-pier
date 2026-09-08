import { commonCopy } from "../../lib/i18n/messages/common.js";
import { repositoryPickerCopy as copy } from "../../lib/i18n/messages/repositories.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import React from "react";
import SearchSelect from "../../components/SearchSelect.jsx";
import useRepositoryDiscovery from "./useRepositoryDiscovery.js";
export default function RepositoryPicker({ credentialId, url, onSelect }) {
  const {
    busy,
    organization,
    setOrganization,
    setPage,
    data,
    query,
    setQuery,
    error,
    setReload,
    page,
  } = useRepositoryDiscovery({
    credentialId,
    url,
    onSelect,
  });
  return (
    <div className="repository-picker" aria-busy={busy}>
      <SearchSelect
        label={copy.organizationLabel}
        searchLabel={copy.searchOrganizations}
        value={organization}
        placeholder={copy.repositoryPickerFiltersOption}
        options={[
          { value: "", label: copy.repositoryPickerFiltersOption },
          ...data.organizations.map((item) => ({ value: item.login, label: item.login })),
        ]}
        onChange={(value) => {
          setOrganization(value);
          setPage(1);
        }}
      />
      <SearchSelect
        label={copy.repositoryPickerFieldLabel}
        searchLabel={copy.searchRepositories}
        value={url}
        selectedLabel={url ? url.replace(/^https?:\/\//, "").replace(/\.git$/, "") : ""}
        placeholder={copy.chooseRepository}
        options={data.repositories.map((item) => ({
          value: item.url,
          label: `${item.fullName} · ${item.private ? commonCopy.private : commonCopy.public}`,
        }))}
        query={query}
        onQuery={(value) => {
          setQuery(value);
          setPage(1);
        }}
        busy={busy || Boolean(error)}
        onChange={(value) => {
          const selected = data.repositories.find((item) => item.url === value);
          if (selected) onSelect(selected);
        }}
        footer={
          !error &&
          (page > 1 || data.hasMore) && (
            <div className="repository-pagination">
              <button
                type="button"
                className="button secondary compact"
                disabled={busy || page === 1}
                onClick={() => setPage((value) => value - 1)}
              >
                {copy.previousRepositories}
              </button>
              <button
                type="button"
                className="button secondary compact"
                disabled={busy || !data.hasMore}
                onClick={() => setPage((value) => value + 1)}
              >
                {copy.nextRepositories}
              </button>
            </div>
          )
        }
      />
      <ErrorMessage error={error} />
      {error ? (
        <button
          type="button"
          className="button secondary compact"
          onClick={() => setReload((value) => value + 1)}
        >
          {copy.retrySearch}
        </button>
      ) : (
        <p className="field-description" role="status">
          {busy
            ? copy.repositoriesLoading
            : data.total
              ? copy.repositoryResultsSummary(data.total, page)
              : copy.noMatchingRepositories}
        </p>
      )}
      {!error && data.truncated && (
        <p className="field-description">{copy.searchLimitDescription}</p>
      )}
    </div>
  );
}
