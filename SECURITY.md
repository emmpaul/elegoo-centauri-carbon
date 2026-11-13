# Security policy

This service can pause and stop a physical 3D printer and stream its camera, so
security reports are welcome and taken seriously.

## Reporting a vulnerability

Report privately through GitHub:
[Security → Report a vulnerability](https://github.com/emmpaul/elegoo-centauri-carbon/security/advisories/new).
Please don't open a public issue for security problems.

Include what you found, how to reproduce it, and what an attacker could do with
it. You'll get an answer within a week.

## Supported versions

Only the latest release gets fixes.

## Deployment expectations

The service is built for a trusted home network:

- Set an access token (`token` in `config.json` or `ACCESS_TOKEN`). Without one,
  anyone who can reach the port can control the printer.
- Don't expose the port directly to the internet. For remote access use a VPN or
  an authenticating reverse proxy with HTTPS.

Issues that need the service to be exposed without a token are out of scope,
since the README asks for both.
