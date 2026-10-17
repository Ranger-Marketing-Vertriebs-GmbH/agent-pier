import path from "node:path";
import { githubMcpManifest, githubMcpPlatform } from "./github-mcp-manifest.js";
import { installGithubMcp, managedGithubMcp } from "./github-mcp-installer.js";
import { run } from "./tool-run.js";
import { cleanEnvironment } from "../accounts/account-store.js";
import { serverMessages } from "../../lib/i18n/de.js";

/**
 * The managed GitHub MCP server as the running AgentPier keeps it (AGENTPIER-129):
 * installed in the background on first use (an agent gains GitHub access), brought
 * to the pinned version at each server start after an AgentPier update, and
 * reported to the Work tab. `onReady` runs after each successful install, so agents
 * waiting for the server get it without a restart.
 */
export class GithubMcpTool {
  constructor({
    dataDir,
    manifest = githubMcpManifest,
    install = installGithubMcp,
    platform = process.platform,
    arch = process.arch,
    fetchImpl = fetch,
  }) {
    Object.assign(this, { manifest, install, platform, arch, fetchImpl });
    this.root = path.join(dataDir, "clis");
    this.job = null;
    this.status = "idle";
    this.message = "";
    this.onReady = null;
  }
  installed() {
    return managedGithubMcp(this.root);
  }
  /** The executable agents' servers run, or null while none is installed. */
  executable() {
    return this.installed()?.executable || null;
  }
  state() {
    const installed = this.installed();
    const available = !!githubMcpPlatform(this.manifest, this.platform, this.arch);
    return {
      available,
      installed: !!installed,
      version: installed?.version || null,
      pinnedVersion: this.manifest.version,
      status: this.job ? "running" : this.status,
      // A German server text; the client translates it by its message identity.
      message: available
        ? this.message
        : serverMessages.tools.githubMcpPlatformUnavailable,
    };
  }
  /** Starts an install or update unless the pinned version is in place or one runs. */
  ensure() {
    if (this.job) return this.job;
    if (this.installed()?.version === this.manifest.version) return null;
    if (!githubMcpPlatform(this.manifest, this.platform, this.arch)) return null;
    this.status = "running";
    this.message = "";
    this.job = this.install({
      root: this.root,
      manifest: this.manifest,
      platform: this.platform,
      arch: this.arch,
      fetchImpl: this.fetchImpl,
      run,
      env: cleanEnvironment(),
    })
      .then(() => {
        this.status = "succeeded";
        this.onReady?.();
      })
      .catch((error) => {
        this.status = "failed";
        this.message = error?.status
          ? error.message
          : serverMessages.tools.githubMcpDownloadFailed;
      })
      .finally(() => {
        this.job = null;
      });
    return this.job;
  }
  /** At a server start: an installed server follows a newer pinned version. */
  keepCurrent() {
    const installed = this.installed();
    if (installed && installed.version !== this.manifest.version) this.ensure();
  }
}
