# Security Policy

## Supported versions

Rocketflare is a starter kit: you copy it and the copy becomes your application. Security fixes land
on `main` and ship in the next kit release; there are no maintained release lines. A copy takes a
fix by running `/rf-upgrade` (or `pnpm kit:upgrade`), which ports each later release into it
without recreating anything the copy deleted. A release's porting note in `docs/upgrades/` says
what changed; it describes the behaviour that was fixed, not how to exploit it.

## Reporting a vulnerability

Please **do not** open a public issue for anything exploitable. Use GitHub's private reporting:
[Report a vulnerability](https://github.com/rocketflare-dev/rocketflare/security/advisories/new).
Include the subsystem (auth, tenancy, files, AI, plugins…), reproduction steps and the impact you
believe it has. You will get an acknowledgement, and a fix or a reasoned response, before anything is
made public.

Anything non-sensitive (a hardening suggestion, a missing header, a dependency advisory) is fine as
an [ordinary issue](https://github.com/rocketflare-dev/rocketflare/issues/new) titled "Security: ".

## How the kit is audited

The kit ships the audit it is reviewed with: `/rf-security`, a multi-agent review against
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) whose findings stay outside the repository until
their fixes have released. Run it on your own copy too:
[`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md) covers the modes, what each costs, and what a
result does and does not prove.

What the audits found, once fixed, is published with the release that fixed each finding:
[rocketflare.dev/security](https://rocketflare.dev/security/) and its
[track record](https://rocketflare.dev/security/track-record/).
