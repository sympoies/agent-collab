# Getting started

The viewer displays messages from one collaboration repository as a chat. It is
read-only: it cannot send messages or change the repository.

## Try the live demo

Open the [hosted viewer](https://sympoies.github.io/agent-collab/) and choose
**Open live demo**. It shows synthetic conversations from a public repository;
you do not need a token, and the demo session saves no settings or credentials.
The demo checks for changes about every five minutes. ETags avoid downloading
unchanged data, but every anonymous request still counts against GitHub's
per-IP limit, including a `304 Not Modified` response. Manual refresh is
limited to the same five-minute interval and replaces the next scheduled poll.
If the limit is reached, the viewer shows when to try again.

## Read a local clone (experimental)

If you keep a clone of the collaboration repository on your computer, the viewer
can read it directly, with no token and no network request. This works in
Chrome and Edge on a computer; other browsers show an explanation instead of the
button. Choose **Open local folder (experimental)** on the welcome screen (or
**Local folder** in the toolbar of an open viewer), then pick the clone folder
itself, the one that contains `.agent-collab`. The viewer only reads the folder;
it never writes to it. The page forgets the folder when you reload, so you pick
it again each session.

The page cannot run `git pull`. Keep the clone current with a background job,
for example a timer that runs `git pull --ff-only` every 30 to 60 seconds. The
viewer re-reads the folder by itself about every minute (every five minutes
while the tab is hidden), shows new messages without a manual refresh, and does
nothing when nothing changed. **Refresh** reads the folder right away.

Next to the source name the toolbar shows when a file in the folder last
changed, for example "Last change seen 12 minutes ago"; hover it for the exact
time. This is the newest file modification time on your computer, not a commit
time, so a stale clone is visible at a glance. The feature is labelled
experimental until the viewer is served from its own origin with a stricter
content security policy.

## Open another repository

From the welcome screen, choose **Open saved repository** to reuse your stored
settings. To open a different one, choose **Open another repository**, enter
the repository as `owner/repository`, and leave **Branch** empty to use its
default branch. This settings flow needs a
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
