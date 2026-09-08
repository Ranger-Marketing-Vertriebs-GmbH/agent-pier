# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
[Report a vulnerability](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/security/advisories/new)
form. Do not disclose an unpatched vulnerability in a public issue or pull request.

Include the affected version, platform, a minimal reproduction using synthetic
data, the expected boundary and the observed impact. Never send live tokens,
passwords, private keys or a copy of your real AgentPier data directory. Redact
logs and screenshots. Coordinate public disclosure through the private report.

This is a community-maintained project without a guaranteed response-time SLA.

## Supported versions

Security fixes target the latest released version on the main development line.
Older releases do not have a separate long-term support commitment. Update before
testing whether an issue is still present, when doing so is safe for your setup.

## Deployment model

AgentPier is a trusted local workspace for coding tools. Its CLIs execute as the
server's OS user. The web login, host/origin validation, account-scoped credentials
and private runtime files protect specific boundaries; they do not isolate
mutually untrusted operating-system users or malicious local software.

Complete initial user setup before sharing permitted network access. Use the
documented private remote-access configuration and protect the machine and its
backups. Credentials are stored in private files and are not automatically
encrypted at rest. See [login](docs/login.md) and [remote access](docs/remote-access.md).
