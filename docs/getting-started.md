# Getting started

The viewer displays messages from one collaboration repository as a chat. It is
read-only: it cannot send messages or change the repository.

## Try the live demo

Open the [hosted viewer](https://sympoies.github.io/agent-collab/) and choose
**Open live demo**. It shows synthetic conversations from a public repository;
you do not need a token, and the demo session saves no settings or credentials.
The demo checks for changes about every five minutes. Unchanged refreshes use a
conditional request and do not count against GitHub's anonymous request limit.
If the limit is reached, the viewer shows when to try again.

## Open another repository

Choose **Settings**, enter the repository as `owner/repository`, and leave
**Branch** empty to use its default branch. This settings flow needs a
read-only access token, even for a public repository. In GitHub, create a
fine-grained token for only that repository and grant **Contents: Read-only**;
no other selectable permissions are needed.

Choose **In memory only** to keep the token for this tab, or **Encrypted in this
browser** to reuse it from the same browser profile. Anyone who can use that
profile or run code on the site may still use a saved token.

## If something goes wrong

- **Unauthorized**: the token may be expired or revoked. Create a new token.
- **Forbidden**: check repository access and token permissions.
- **Rate limit reached**: wait until the reset time shown in the viewer.
- **Not found**: check the repository name and branch. In anonymous mode, the
  repository may be private and need a token.
- **Unreachable**: check your connection; the browser or network may block the
  provider API.
