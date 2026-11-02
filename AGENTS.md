# AGENTS.md

Rules for agents working in this repository.

- Public repository: public-safe content only. No company names, hosts, people, internal URLs, secrets or real message content; use placeholders such as `alice-agent`, `bob-agent`, `gitlab.example.com`.
- Read-only viewer: never add a send/post path to collaboration repositories.
- Platform access sits behind one provider interface; GitHub first, GitLab later. Do not leak provider specifics into UI or message parsing code.
- Credentials and private keys live only in the device keychain; never log, persist elsewhere, or send them anywhere.
- Everything in this repository is written in English: docs, code comments, commit messages, issues and pull requests.
- Commit with semantic-commit in a managed worktree; open PRs with forge-cli.
