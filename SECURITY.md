# Security Policy

We take the security of Openship and the data it manages seriously. We're
grateful to the researchers and users who help keep Openship and its community
safe, and we welcome your reports.

## Reporting a Vulnerability

Please report vulnerabilities **privately** — don't open a public issue, pull
request, or discussion, and don't disclose the issue publicly until we've had a
chance to address it.

Use either channel:

- **GitHub Private Vulnerability Reporting (preferred):**
  <https://github.com/oblien/openship/security/advisories/new>
- **Email:** <security@oblien.com> — if the details are sensitive and you'd like
  to encrypt them, email us first and we'll arrange a secure channel.

You don't need a complete or polished report to reach out. A partial finding is
far more useful to us than a silent one — send what you have and we'll work
through it with you.

## What to Include

The more of this you can provide, the faster we can validate and fix:

- A clear description of the issue and its security impact
- Step-by-step reproduction, with a proof-of-concept where possible
- Affected component(s), and the version, commit, or URL
- Any preconditions (auth level, configuration, self-hosted vs. cloud)
- Suggested remediation, if you have one

## Safe Harbor

We consider security research and vulnerability disclosure carried out in good
faith under this policy to be **authorized**. For such research we will:

- Not pursue or support legal action against you related to your research
- Work with you to understand and resolve the issue promptly
- Credit you for a valid, first-of-its-kind report, if you'd like

Good-faith research means you:

- Only test against scope you're authorized for — your own account, your own
  self-hosted instance, or a test account you control
- Avoid privacy violations, data loss, and service degradation; access only the
  minimum data needed to demonstrate the issue
- Never exfiltrate, store, or share data belonging to others, and delete any
  incidentally accessed data once it's reported
- Give us reasonable time to remediate before any public disclosure

If you're unsure whether something is allowed, email <security@oblien.com> and
ask first. Work done consistent with this policy is treated as authorized — if
something is ambiguous, we'll help clarify it rather than treat it as a
violation.

## Scope

In scope — all Openship components:

- Managed Openship Cloud
- Self-hosted control plane (API, dashboard, CLI)
- Desktop app
- GitHub integration & webhooks
- The build/deploy pipeline and deployment targets
- Backups & recovery
- Domains & TLS, and the edge (OpenResty) layer
- Mail functionality

Openship is open source (Apache 2.0), so the fastest and safest way to test most
issues is against **your own self-hosted instance**.

## Out of Scope

- Vulnerabilities in already-public third-party dependencies (report upstream;
  do tell us if Openship is exploitable through one)
- Theoretical issues with no realistic attack scenario or proof-of-concept
- Self-XSS, or issues requiring physical access to a user's device
- Social engineering of Openship staff, users, or infrastructure providers
- Volumetric denial-of-service / resource-exhaustion testing
- Missing security headers or best-practice suggestions with no demonstrated impact
- Raw automated-scanner output without a validated, exploitable finding

## Supported Versions

| Version | Supported |
|---|---|
| Latest release | ✅ |
| Pre-release / beta | ✅ (lower priority) |
| Older releases | ❌ (please upgrade) |

Self-hosted operators: security fixes ship in the latest release — keep your
instance current.

## Our Response

Targets, in business days, from receipt:

- **Acknowledgement:** within 5 days
- **Triage / initial assessment:** within 10 days
- **Fix:** prioritized by severity — critical issues are expedited
- **Coordinated disclosure:** after a fix is available, by mutual agreement,
  typically within 90 days of the report

We'll keep you updated as we work through it, and tell you when a fix ships.

## Recognition

With your permission, we credit reporters of valid, first-to-report issues in the
relevant advisory or release notes. Openship does not currently run a paid
bug-bounty program.

## Questions

For anything that isn't itself a vulnerability report, see the
[Trust & Security](https://openship.io/trust) page or reach us at
<security@oblien.com>.
