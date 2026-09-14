import React from "react";
import DirectoryTree from "./DirectoryTree.jsx";

export default function ExplorerDirectoryTree({
  client,
  context,
  hidden,
  preferences,
  projects,
  open,
  navigate,
}) {
  return (
    <DirectoryTree
      client={client}
      context={context}
      hidden={hidden}
      favorites={preferences.preferences.favorites}
      projects={projects}
      onNavigate={(path) => {
        open?.(false);
        navigate(path);
      }}
      onRemoveFavorite={(id) =>
        preferences
          .update((latest) => ({
            favorites: latest.favorites.filter((favorite) => favorite.id !== id),
          }))
          .catch(() => {})
      }
      onClose={open ? () => open(false) : null}
    />
  );
}
