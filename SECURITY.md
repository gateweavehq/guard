# Security policy

## Supported versions

Gateweave Guard is in early development. Security fixes go into `main` and the latest release only.

## Reporting a vulnerability

Please report vulnerabilities privately, never in a public issue or pull request.

- Preferred: [open a private security advisory](https://github.com/gateweavehq/guard/security/advisories/new)
  on GitHub.
- Or email **security@gateweave.com**.

Include what an attacker could do, the steps to reproduce it, and the affected version or commit.
We aim to reply within three working days, and will keep you updated while we work on a fix,
and credit you in the release notes unless you would rather stay anonymous.

## Scope

Areas where reports are especially valuable:

- Access to a workspace's data without membership: through its pages and server functions.
- Authentication and session handling, including sign-in through a provider, password reset, and
  the limits on password tries and account changes.
- Anything that lets one workspace member act with another member's identity or role, or become
  an owner or admin without being made one.
- Secrets (`BETTER_AUTH_SECRET`, a provider's client secret) reaching a page, a log or a response.
- The deployment owner's rules for who may make an account, and anything that lets someone make
  an account on a closed deployment, or act as its owner, without a way in.
- Once it exists: anything that lets Guard write to a Cloudflare account or a repository it only
  reads, a connection's token reaching a page, a log or a response, or traffic data that names an
  address, a user agent or a path.
