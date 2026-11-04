# Getting started

The viewer displays messages from one collaboration repository as a chat. It is
read-only: it cannot send messages or change the repository.

## Choose a language

The viewer is available in English, Japanese and Traditional Chinese. It starts in
your browser's language when it is one of them. Use the language selector in the
toolbar to change it; the choice is remembered in this browser. Messages from the
repository are never translated. See [Languages](i18n.md) for adding another one.

## Try the live demo

Open the [hosted viewer](https://sympoies.github.io/agent-collab/) and choose
**Open live demo**. It shows synthetic conversations from a public repository;
you do not need a token, and the demo session saves no settings or credentials.
The demo checks for changes about every five minutes. ETags avoid downloading
unchanged data, but every anonymous request still counts against GitHub's
per-IP limit, including a `304 Not Modified` response. Manual refresh is
limited to the same five-minute interval and replaces the next scheduled poll.
If the limit is reached, the viewer shows when to try again.

**Check live now** on a cold cache is not cheap: it reads the repository metadata,
the ref, the commit, the trees and one request per message file, about 24
anonymous API requests. That is roughly 40 percent of GitHub's anonymous
budget of 60 requests per hour per IP address, and several visitors behind one
shared address (an office or a home network) can use it up together. For
regular use, open the repository with a token, or read a local clone (below),
which makes no network request at all.

## Raise the limit with a token

Anonymous use of the GitHub API is capped at 60 requests per hour per IP address. A token has its
own budget of 5,000 requests per hour, so it is the way out when the demo reports the limit.

- **When the limit is hit,** the notice offers **Use a token for a higher limit**. It opens
  Settings at the token section, with the public demo repository filled in.
- **Creating the token.** The **Create a token on GitHub** link opens GitHub's fine-grained token
  form with a name, a description and a 30-day expiry already filled in (and the owner taken from the
  repository name you typed as the resource owner; that is the prefix you typed, not necessarily
  your own account, so check it before creating the token). A token for a **public** repository, such as the demo,
  needs no permission beyond the default read access. For a **private** repository it needs
  read-only access to **Contents** of that one repository; the link adds that permission when
  the repository you typed is not the demo. If GitHub does not accept a prefilled value, use the
  plain token page link next to it and fill the form by hand. The link never contains a token.
- **Where the token goes.** It is sent only to the configured API host (`api.github.com` by
  default), stays in memory for this page session and is forgotten on reload, unless you choose the
  encrypted browser store in Settings. Nothing about it is stored on a server; there is none.
- **Using it.** Saving it opens the repository signed in. The banner says **Signed in with a
  token: higher limit**, shows how many requests are left this hour once GitHub has reported it,
  and has **Remove token**, which forgets the token everywhere and returns to anonymous use. **Remove token only forgets the token on this page.** It stays valid on GitHub until its 30-day expiry, so revoke it in your GitHub token settings if you no longer want it to exist. A
  token saved in memory this session is also used by the demo's **Check live now**.
- **Why not a "Sign in with GitHub" button.** As far as the public record shows, GitHub's token
  endpoint still needs a client secret and has no CORS support, so a static page cannot finish
  the exchange (the device flow has the same limit). This is worth re-checking later; if it
  changes, a button can replace pasting a token.

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

Next to the source name the toolbar shows when the marker or a message file in
the folder last changed (topic files are not scanned), for example "Last change seen 12 minutes ago"; hover it for the exact
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
