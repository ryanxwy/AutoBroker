# Contributing

AutoBroker is a personal/portfolio project. External contributions are welcome
as issues and discussion; pull requests may not be merged promptly (or at all),
but they are read and appreciated. If you are building something inspired by
this codebase, feel free to fork it — it is MIT-licensed.

---

## Prerequisites

- **Node.js ≥ 24.13.0** (`node --version`; see `.nvmrc`). The repo uses
  `engine-strict=true` — older Node versions will be rejected.
- **pnpm 9** (`npm install -g pnpm@9` or `corepack enable && corepack use pnpm@9`).

---

## Setup

```bash
git clone https://github.com/ryanxwy/AutoBroker.git
cd AutoBroker
pnpm install
cp .env.example .env
# Edit .env and add at least DEEPSEEK_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY).
# Read README.md § Privacy before setting any key.
```

## Running the gate

The single pass/fail signal for the whole repository:

```bash
bash scripts/green.sh
```

This runs in order: `typecheck` → harness typecheck → `lint:deps` →
`check:strings` → `db:check` → `test`. Set `RUN_UI_FUNCTIONAL=1` to also run
the real-DOM Playwright functional UI lane (adds ~1 minute; CI always runs it).

---

## Architecture and commit conventions

The repo is a strict five-layer pnpm monorepo:

```
core  ->  model  ->  workflows  ->  tools  ->  app
```

Each layer may only import from layers to its left. This wall is enforced by
TypeScript project references and `dependency-cruiser` at CI time. Treat any new
cross-layer import not already encoded in a package `tsconfig.json` as an
architecture change.

Commit message prefix convention: **`phaseN/<skill>:`** (e.g.
`phase1/quote_audit:`). For general fixes, `fix:` or `chore:` are acceptable.
The `feat:` prefix is rejected by the commit hook; use the phase/skill prefix
instead.

Forbidden strings: never write the stale suffixed repo names anywhere in a
tracked file (enforced by `pnpm check:strings`).

---

## Related documents

- [LICENSE](LICENSE) — MIT
- [SECURITY.md](SECURITY.md) — vulnerability reporting
- [docs/DATA_HANDLING.md](docs/DATA_HANDLING.md) — data handling and privacy
- [CLAUDE.md](CLAUDE.md) — full safety invariants and architectural rules
