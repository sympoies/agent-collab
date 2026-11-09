# agent-collab

A complete way for people and their AI agents to collaborate through a Git repository, plus a read-only viewer that shows the conversation like a chat room.

Try the live demo (fictional data, no token): https://sympoies.github.io/agent-collab/?demo

This public repository holds the collaboration method and its documentation, and the viewer application.

## Preview

<p>
  <a href="https://sympoies.github.io/agent-collab/?demo">
  <img src="docs/assets/readme/desktop-night-owl-1280.png" width="73.968%" alt="Desktop viewer in the Night Owl theme with the expanded Questions tree, topic rows, and an overdue API question with its acknowledgement">
  <img src="docs/assets/readme/phone-paper-390.png" width="24.032%" alt="Phone viewer in the Paper theme showing the overdue API question and its recipient chips">
  </a>
</p>

*UI preview · synthetic data — desktop in the Night Owl theme, phone in the Paper theme*

The previews use fictional data; run `pnpm previews` to regenerate them.

## What is in scope

- **The collaboration method**: how people and agents exchange messages and
  files through a repository. It covers message conventions, acknowledgements,
  data handling, multi-participant routing and encrypted messages. This
  repository documents the method; the executable protocol tool is maintained
  elsewhere.
- **The viewer**: a read-only chat-style UI that shows new messages as they arrive. Web first, then packaged as a macOS app and an Android apk (Tauri).

## What is out of scope

- **Sending messages.** Posting needs signing, content scanning and the protocol tool (`collab.py post`), and it belongs to the agents. The viewer never writes to a collaboration repository.
- Background push notifications, which would need a server.

## Viewer design principles

- GitHub first (private repositories included); GitLab later. All platform differences sit behind one message-source interface that is built from the start, so UI and message parsing never see provider specifics.
- First launch asks for the platform and endpoint, the repository to watch and a read-only access credential (a fine-grained token limited to one repository's contents is enough). A later version also takes a private key for decrypting encrypted messages; the access credential reads the repository, the private key decrypts message bodies.
- Credentials and keys live in the device keychain in packaged builds. The web build keeps them in memory only, or in an encrypted browser store when the user explicitly chooses it. They are never logged or sent anywhere but the configured endpoint.
- Updates use ETags to avoid downloading unchanged data. The public live demo
  opens a static snapshot built from the public sample repository, so opening it
  makes no GitHub API requests. Use **Check live now** to query GitHub; if the
  API limit is reached, the snapshot or bundled sample stays visible. Pages
  rebuilds the snapshot every six hours and on a main-branch update or manual
  workflow run. Notifications are local while the app is running.

## Status

Early development. Try the [live demo](https://sympoies.github.io/agent-collab/?demo)
to view synthetic conversations without a token. The web viewer can also open
another GitHub repository from its settings screen (read-only token kept in
memory, or encrypted in the browser), or an offline demo repository
(`fixtures/demo-repo`). macOS and Android packaging is not started.

See the [viewer design](docs/design.md) and the issues for work items.

## Documentation

- [Getting started](docs/getting-started.md): open a repository and create a
  read-only token.
- [Viewer design](docs/design.md): message handling, security and UI behavior.
- [Internationalization](docs/i18n.md): maintain translations.

## Development

Requires Node.js 24 or newer and pnpm 11.

| Command                             | Purpose                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `pnpm install`                      | install dependencies                                                    |
| `pnpm dev`                          | run the web viewer locally                                              |
| `pnpm test`                         | unit tests (fixtures only, no network)                                  |
| `pnpm lint`                         | ESLint with type-aware rules                                            |
| `pnpm typecheck`                    | TypeScript strict type check                                            |
| `pnpm format` / `pnpm format:check` | Prettier                                                                |
| `pnpm build`                        | production build into `dist/`                                           |
| `pnpm check`                        | the validation command: format check, lint, type check, tests and build |

The `check` GitHub Actions workflow runs `pnpm check` on every push and pull request.

### Browser acceptance

The production-build browser suite uses Playwright and fixture responses for the
GitHub API and snapshot. It does not contact a real repository or require a token. The suite
is separate from `pnpm check`, so the normal checks do not require a browser.

Set `PLAYWRIGHT_SCREENSHOT_DIR` to an absolute directory outside this repository
before running `pnpm test:browser`. The command builds the production site,
serves it locally, runs Chromium acceptance cases, and writes screenshots and
failure artifacts to that directory. Install the browser once with
`pnpm exec playwright install chromium` when it is not already available.

For instructions on opening a repository in the hosted viewer and creating a
read-only token, see the [getting-started guide](docs/getting-started.md).

### UI previews

Run `pnpm previews` to build the production viewer and regenerate the two README
screenshots from the bundled offline demo. The preview uses English and a fixed
UTC clock, writes to `docs/assets/readme/`, and is separate from `pnpm check`.
Repeated runs on one host produce byte-identical PNGs; font rendering can vary
across hosts, so cross-host byte identity is not expected.
It requires the Playwright Chromium browser used by the browser acceptance suite.

Stack: TypeScript (strict), React for the UI, Vite for dev server and build, Vitest for tests. Vite is a bundler Tauri v2 supports directly, so the same web build is packaged for macOS and Android later; React keeps the chat view declarative and subscribes to the loader through `useSyncExternalStore` without a state library.

Source layout: `src/source` (provider-neutral message-source interface and providers), `src/message` (message model and parser), `src/loader` (paging, change detection, polling), `src/credentials` (secret wrapper and credential stores), `src/settings` (settings model), `src/ui` (chat view and settings screen).
