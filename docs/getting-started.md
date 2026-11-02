# Getting started

The viewer displays messages from one collaboration repository as a chat. It is
read-only: it cannot send messages or change the repository.

## Open a repository

On first launch, choose **GitHub**, keep the API endpoint as
`https://api.github.com` (or enter your GitHub Enterprise endpoint), and enter
the repository as `owner/repository`. Leave **Branch** empty to use the
repository's default branch. The viewer also asks for an access token.

To create a token in GitHub:

1. Open your profile menu, then **Settings** › **Developer settings** ›
   **Personal access tokens** › **Fine-grained tokens**.
2. Choose **Generate new token**, select the repository owner, and choose
   **Only select repositories**. Select just the repository you want to view.
3. Under repository permissions, set **Contents** to **Read-only**. GitHub also
   grants **Metadata: Read-only** automatically; leave other selectable
   permissions at **No access**. Choose an expiry and generate the token.
4. Copy the token and enter it in the viewer's **Access token** field. GitHub
   shows the token only when it is created.

## Choose how to keep the token

- **In memory only** keeps the token for this tab. Reloading the page means you
  enter it again.
- **Encrypted in this browser** encrypts the token in this browser profile so
  it can be reused later. The token and encryption key are stored for this
  browser origin. Anyone who can use this browser profile or run code on this
  site may still use the token. Other sites sharing the origin can access both
  the encrypted token and its key.

  On a `github.io` address, project sites for the same account share an origin.
  A sibling project can access the saved token and key, so prefer **In memory
  only** there. A dedicated custom domain removes this sibling-project
  exposure.

Encrypted messages appear as **locked**. They are encrypted, and this viewer
does not decrypt them yet.

## If something goes wrong

- **unauthorized (HTTP 401)**: the token may be expired or revoked. Create a
  new token and update the viewer.
- **forbidden (HTTP 403)**: check that the token can read this repository.
- **rate-limited (HTTP 403 or 429)**: wait and try again later.
- **not-found (HTTP 404)**: check the repository spelling and Branch. If the
  repository was renamed, enter its current name.
- **unreachable**: check your connection and endpoint. A browser or network
  restriction may block the provider API.
- **too-large**: the repository listing exceeds the provider's limit; the
  viewer cannot load that listing.
- **unexpected (for example, HTTP 5xx)**: try again later. Leave Branch empty
  to use the repository's default branch, and use **Refresh** after correcting
  settings.

The hosted site requires the repository maintainer to enable GitHub Pages:
open repository **Settings** › **Pages**, then choose **GitHub Actions** as the
build and deployment source. Then open **Actions** › **pages** and choose **Run
workflow** on `main`, or push a new commit to `main`. The workflow only runs on
pushes to `main` or when started manually.
