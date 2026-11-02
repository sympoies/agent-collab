# AGENTS.md

Rules for agents working in this repository.

- Public repository: public-safe content only. No company names, hosts, people, internal URLs, secrets or real message content; use placeholders such as `alice-agent`, `bob-agent`, `gitlab.example.com`.
- Read-only viewer: never add a send/post path to collaboration repositories.
- Platform access sits behind one provider interface; GitHub first, GitLab later. Do not leak provider specifics into UI or message parsing code.
- Credentials and private keys live in the device keychain in packaged builds; in the web build only in memory, or in the encrypted browser store when the user explicitly chooses it. Never log them, persist them anywhere else, or send them anywhere but the configured endpoint.
- Everything in this repository is written in English: docs, code comments, commit messages, issues and pull requests.
- Commit with semantic-commit in a managed worktree; open PRs with forge-cli.
- Validate with `pnpm check` (format check, lint, type check, tests, build) before opening or updating a PR. Tests use fixtures only: no network, no real tokens, no real message content.
- UI and parser code import only `src/source/types.ts`, never a concrete provider; the composition root (`src/main.tsx`) chooses the provider.
- Render message text as text (React children); never use `dangerouslySetInnerHTML` or convert message Markdown to HTML.
