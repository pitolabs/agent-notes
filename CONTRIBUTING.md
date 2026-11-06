# Contributing

Thanks for stopping by. Issues and pull requests are welcome; small, focused changes land fastest.

## Setup

```bash
git clone git@github.com:pitolabs/agent-notes.git && cd agent-notes
bun install          # also turns the git hooks on (core.hooksPath .githooks)
bun run typecheck && bun test && bun run format:check
```

Bun 1.4 (`packageManager` in `package.json`) and Biome 2.6 pinned in `devDependencies`; Biome runs only through
`scripts/biome.sh`, never from PATH. `bun run format` formats; `bun run build` emits `dist/` (the CLI is
`dist/cli/main.js`). The hooks and the checks CI runs need [mise](https://mise.jdx.dev) (`brew install mise`): it
installs the gitleaks, jactionlint, zizmor, shellcheck and osv-scanner pinned in `mise.toml`, each checked against
`mise.lock`; `mise run check` runs them all.

## The hooks

- **pre-commit** formats the staged files and refuses a commit whose staged changes carry a secret or personal data
  (`scripts/privacy-scan.sh --staged`: the mise-pinned gitleaks with the rules in `.gitleaks.toml`, plus a private
  blocklist kept outside the repository).
- **pre-push** runs the same scan over every outgoing commit, and requires every author/committer e-mail to be a
  GitHub noreply address: `git config user.email "<id>+<login>@users.noreply.github.com"` (`gh api user --jq .id`).

The scan needs `~/.config/privacy/blocklist.txt` to exist; an empty file is fine for a contributor. Test fixtures must
use fictional identities: a Brazilian-shaped phone number is refused even when made up (use a US `555` number).

## Tests

`bun test` runs everything under `test/` against temporary folders, an in-memory libSQL and a stub embedder (in
process, or a local `/embeddings` server for the MCP tests); no network, no keys. Keep new tests deterministic and
about behaviour a consumer can see.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) says; not in a public issue.

## Releasing

Bump `version` in `package.json`, commit, push, create a GitHub release tagged `vX.Y.Z`; `publish.yml` runs the checks
and publishes to npm.
