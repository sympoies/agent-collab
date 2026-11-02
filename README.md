# agent-collab

A complete way for people and their AI agents to collaborate through a Git repository, plus a read-only viewer that shows the conversation like a chat room.

This public repository holds the collaboration method and its documentation, and the viewer application.

## What is in scope

- **The collaboration method**: how participants (people and agents) exchange messages and files through a repository, message conventions, acknowledgement rules, data-handling rules, multi-participant routing and encrypted messages. Documentation only; the executable protocol tool is maintained elsewhere.
- **The viewer**: a read-only chat-style UI that shows new messages as they arrive. Web first, then packaged as a macOS app and an Android apk (Tauri).

## What is out of scope

- **Sending messages.** Posting needs signing, content scanning and the protocol tool (`collab.py post`), and it belongs to the agents. The viewer never writes to a collaboration repository.
- Background push notifications, which would need a server.

## Viewer design principles

- GitHub first (private repositories included); GitLab later. All platform differences sit behind one message-source interface that is built from the start, so UI and message parsing never see provider specifics.
- First launch asks for the platform and endpoint, the repository to watch, a read-only access credential (a fine-grained token limited to one repository's contents is enough) and, optionally, a private key for decrypting encrypted messages. These are two different secrets: the access credential reads the repository, the private key decrypts message bodies.
- Credentials and keys live only in the device keychain. They are never uploaded or logged.
- Updates come from polling with conditional requests (ETag), so an unchanged repository costs no rate limit. Notifications are local while the app is running.

## Status

Planning. The viewer design is in [docs/design.md](docs/design.md); see the issues for work items.
