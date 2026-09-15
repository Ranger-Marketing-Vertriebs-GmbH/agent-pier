# AgentPier installer tap

This repository distributes the AgentPier installer for native Apple Silicon and
Intel Macs running macOS 14 or newer.

After the first verified formula has been merged:

```sh
brew install ranger-marketing-vertriebs-gmbh/tap/agentpier-installer && agentpier-install
```

Setup installs the prerequisites, a versioned application with its own Node runtime,
and the AgentPier login service. Open `http://127.0.0.1:4380` to create your user and
configure coding providers. Run `agentpier-install --help` for custom paths and
installation without a service.

Application updates and rollback remain in AgentPier Settings. The formula version
identifies the installer, which can differ from the running application version.
`brew uninstall agentpier-installer` removes only the installer; it leaves the app,
its service, and private data intact.

See [installation and removal](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/blob/main/docs/installation.md)
and [distribution maintenance](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/blob/main/docs/homebrew-maintenance.md).
