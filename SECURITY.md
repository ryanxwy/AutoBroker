# Security Policy

## Supported Versions

AutoBroker is pre-1.0 and under active development. Only the current `main`
branch receives fixes. There is no stable release line.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories](https://github.com/ryanxwy/AutoBroker/security/advisories/new)
or by email to `wangyanx@uci.edu`.

Include: a description of the issue, reproduction steps, and the potential
impact. You will receive a response within a few business days.

## Why Security Matters Here

AutoBroker handles sensitive data by design:

- **Private Gmail content** — dealer replies read via the user's own OAuth
  token. That content is passed to the configured LLM provider for extraction.
- **Dealer PII** — dealer contact information, quotes, and negotiation threads
  live in a local SQLite database.
- **LLM API keys** — provider keys are stored in the local OS keychain or `.env`
  file and must never appear in tracked files.

## Safety Posture (summary)

- **Local-first.** All data lives under `~/.autobroker-ts/` on the user's
  machine. The app is not a multi-tenant service; there is no cloud backend.
- **Human approval gates on all irreversible actions.** Side effects can
  physically reach `browser.submit` or `gmail.send` only through the L2
  in-process gate handler, which fails closed. The `AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS=1`
  env fuse provides a redundant outer ring.
- **Secrets are never committed.** `.env`, `keys.json`, and OAuth tokens are
  in `.gitignore`. CI is verified to contain no real credentials.
- **The three irreversible skills** (`dealer_web_lead_submit`,
  `negotiation_followup`, `dealer_closeout_email`) remain fake-send until Phase 5
  acceptance is complete, and their human approval is never hidden on any surface.

See `CLAUDE.md` for the full 12-point safety invariant set.
