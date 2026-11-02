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
3. Under repository permissions, set **Contents** to **Read-only**. Leave other
   permissions at **No access**, choose an expiry, and generate the token.
4. Copy the token and enter it in the viewer's **Access token** field. GitHub
   shows the token only when it is created.

## Choose how to keep the token

- **In memory only** keeps the token for this tab. Reloading the page means you
  enter it again.
- **Encrypted in this browser** encrypts the token in this browser profile so
  it can be reused later. Anyone who can use this browser profile or run code
  on this site may still use it. The token is not plain text in site storage.

Encrypted messages appear as **locked**. They are encrypted, and this viewer
does not decrypt them yet.

## If something goes wrong

- **401**: the token may be expired or revoked. Create a new token and update
  the viewer.
- **403**: check that the token grants **Contents: Read-only** for this
  repository. A rate limit can also temporarily block access; wait and try
  again later.
- **Repository not found**: check the `owner/repository` spelling and confirm
  the token can access it. If the repository was renamed, enter its current
  name.
- **Nothing loads**: check the endpoint and repository, leave Branch empty to
  try the default branch, and use **Refresh**. Network or browser access
  restrictions may also prevent the provider API from loading.

The hosted site requires the repository maintainer to enable GitHub Pages:
open repository **Settings** › **Pages**, then choose **GitHub Actions** as the
build and deployment source. The deployment workflow runs after that setting is
enabled.
