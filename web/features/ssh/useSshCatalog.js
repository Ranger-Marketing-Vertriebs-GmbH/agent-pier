import useSshAccesses from "./useSshAccesses.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";

/**
 * The SSH catalog of Zugänge › SSH/SFTP-Zugänge: accesses, keys and the projects that
 * own them. Same-named projects are told apart by their folder; a project that owns
 * resources but is gone shows as unavailable, so nothing loses its owner silently.
 */
export default function useSshCatalog() {
  const accessList = useSshAccesses();
  const keyList = useSshAccesses("/ssh-keys");
  const projectList = useSshAccesses("/ssh-projects");
  const ready = Boolean(accessList.data && keyList.data && projectList.data);
  const keys = keyList.data?.keys || [];
  const known = projectList.data?.projects || [];
  const projects = known.map((project) => ({
    ...project,
    name: known.some((other) => other.id !== project.id && other.name === project.name)
      ? projectCopy.projectLocation(project.name, project.cwd || project.id)
      : project.name,
  }));
  const resourceProjectIds = [...keys, ...(accessList.data?.accesses || [])]
    .map((item) => item.projectId)
    .filter((id, index, ids) => id && ids.indexOf(id) === index);
  const ownerProjects = [
    ...projects,
    ...resourceProjectIds
      .filter((id) => !projects.some((project) => project.id === id))
      .map((id) => ({
        id,
        name: `${projectCopy.unavailable} · ${id}`,
        unavailable: true,
      })),
  ];
  const sourceProjects = resourceProjectIds.map((id) =>
    ownerProjects.find((project) => project.id === id),
  );
  const projectFor = (item) =>
    ownerProjects.find((project) => project.id === item.projectId);
  const ownerName = (item) => projectFor(item)?.name || projectCopy.global;
  const accesses = (accessList.data?.accesses || []).map((access) => ({
    ...access,
    keyName: keys.find((key) => key.id === access.keyId)?.name || access.keyName,
  }));
  const reload = () => {
    accessList.reload();
    keyList.reload();
    projectList.reload();
  };
  return {
    ready,
    errors: [accessList, keyList, projectList].filter((resource) => resource.error),
    accesses,
    accessesLoaded: Boolean(accessList.data),
    keysLoaded: Boolean(keyList.data && projectList.data),
    keys,
    projects,
    ownerProjects,
    sourceProjects,
    projectFor,
    ownerName,
    setAccesses: accessList.setData,
    setKeys: keyList.setData,
    reloadAccesses: accessList.reload,
    reloadKeys: keyList.reload,
    reload,
  };
}
