# Security Policy

## Supported versions

Rocketflare is a starter kit: you copy it and the copy becomes your application. Security fixes land
on `main`; there are no maintained release lines. Apps built from the kit should track `main` for
fixes and re-apply the ones that matter to them (`docs/ADAPTING.md` §0).

## Reporting a vulnerability

Please **do not** open a public issue for anything exploitable. Use GitHub's private reporting:
[Report a vulnerability](https://github.com/rocketflare-dev/rocketflare/security/advisories/new).
Include the subsystem (auth, tenancy, files, AI, analytics…), reproduction steps and the impact you
believe it has. You will get an acknowledgement, and a fix or a reasoned response, before anything is
made public.

Anything non-sensitive (a hardening suggestion, a missing header, a dependency advisory) is fine as
an [ordinary issue](https://github.com/rocketflare-dev/rocketflare/issues/new) titled "Security: ".
