# Local clone source: design decision

**Update, slices 3 and 4:** the freshness work and the experimental source choice are implemented
(see "Implemented behavior" at the end). The text below keeps the spike's analysis; where it says
"the current loader republishes" or "current cost", read it as the situation before that update.

**Status:** spike recommendation, 2026-11-03. Browser claims below were checked against the cited primary sources on this date; the small spike does not verify native browser behavior.

## Recommendation

Proceed with a Chromium File System Access source as an opt-in, read-only source for a user-selected clone. Keep the source behind `MessageSource`; do not add a picker or settings UI until the freshness and egress questions below are resolved. Keep GitHub, the demo snapshot, and the offline fixture as distinct source choices. The local source reads the working tree, including uncommitted files; it does not inspect Git objects, invoke Git, or write to the folder.

This is the smallest route to a token-free source for supported browsers. It is not yet safe to promise that local message data can never leave the page: the current web CSP permits connections to any HTTPS origin, and source-level read-only behavior does not constrain other page scripts. A local-source production slice must first decide how to serve a stricter local-mode CSP. The source itself performs no network requests.

## Browser support and graceful degradation

`showDirectoryPicker` is the support boundary, not the broader File System API. Feature-detect `window.showDirectoryPicker` and invoke it directly from a user action. Do not infer support from the presence of `File` or IndexedDB. When absent, explain that folder access is unavailable in this browser and offer the helper/local-viewer evaluation described below; do not show a picker that cannot work.

| Browser family | Directory picker support | Decision | Claim status (checked 2026-11-03) |
| --- | --- | --- | --- |
| Chrome desktop | Chrome 86+ | Supported; secure context and user activation required | Verified by [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker) and [Can I use](https://caniuse.com/mdn-api_window_showdirectorypicker) |
| Edge desktop | Edge 86+ | Supported; same API constraints | Verified by [Can I use](https://caniuse.com/mdn-api_window_showdirectorypicker) |
| Firefox desktop | No current support listed | Picker source unavailable | Verified by [Can I use](https://caniuse.com/mdn-api_window_showdirectorypicker); MDN marks the API limited availability |
| Safari desktop | No current support listed | Picker source unavailable | Verified by [Can I use](https://caniuse.com/mdn-api_window_showdirectorypicker); MDN marks the API limited availability |
| Chrome Android | Chrome 132+ | API support is listed; actual device picker UX and clone access are unverified | Version verified by [MDN compatibility data](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker); UX unverified |
| Firefox Android, Safari on iOS | No current support listed | Picker source unavailable | Verified by [Can I use](https://caniuse.com/mdn-api_window_showdirectorypicker) |
| Other mobile browsers | Varies by engine and version | Feature-detect; do not promise support by brand | Unverified as a complete device matrix |

These are API-support claims, not promises that a particular OS folder or browser policy permits a selection. Enterprise policy, embedded webviews, and future browser releases can change behavior.

## Permission and handle lifecycle

1. **First grant:** from a visible user action, call `showDirectoryPicker({ mode: "read" })`. The browser opens its native picker; the user chooses a directory. The picker requires a secure context and transient user activation. The picker may reject with `AbortError` both when the user cancels and when the browser refuses a sensitive directory, so use the neutral message “No folder selected, or the browser does not allow this folder.” No write permission is requested. **Verified:** [MDN picker documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker).
2. **Handle storage:** keep the handle in memory only for the initial hosted slice. GitHub Pages project sites default to paths under the same `<owner>.github.io` origin, so separate repositories under that host share origin-scoped browser storage; a sibling same-origin project's script can access an IndexedDB-stored handle and use its associated permission. **Verified:** [GitHub Pages site locations](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) and [MDN same-origin storage rules](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy). Do not persist a handle in IndexedDB until a dedicated origin (for example, a custom domain used only for this viewer) is selected. Re-pick the clone each browser session. File and directory handles are serializable into IndexedDB in supporting browsers ([Chrome](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)), but serializability does not isolate them from same-origin scripts.
3. **Later use/restart:** because the first slice keeps handles in memory, the user chooses the folder again after a page reload or browser restart. If a future dedicated-origin slice persists a handle, call `queryPermission({ mode: "read" })`; a stored handle may report `prompt`, and `requestPermission({ mode: "read" })` must be called from a fresh user action. A background poll cannot request permission. **Verified:** [MDN permission documentation](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/queryPermission) and the [File System Access permission lifecycle](https://wicg.github.io/file-system-access/#api-filesystemhandle-querypermission).
4. **Revoked/denied:** stop reading and polling, preserve the current in-memory source as unavailable, and offer a user-initiated re-pick. Map permission failures to a safe `forbidden` source error; do not surface browser exception text or local paths. The error state is a product recommendation.

The picker may refuse directories deemed too sensitive or dangerous. The File System Access specification gives examples: browser profile/storage, operating-system files (including `/dev`, `/sys`, `/proc` and Windows system directories), the whole home directory, and the whole Downloads directory. These are examples of user-agent restrictions, not a portable, exhaustive denylist. Say “the browser does not allow this folder; choose the clone directory itself,” and do not guess the user's OS path. **Verified:** [picker exception documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker) and [spec privacy guidance](https://wicg.github.io/file-system-access/#privacy-considerations).

## Read model, refresh and cost

Read only the selected working tree. This deliberately includes uncommitted changes; Git history would be slower and could disagree with what agents currently see. A stale clone remains stale. The UI should identify the chosen source as a local working tree and show “last file change seen” using the newest observed file `lastModified` time, qualified as a local filesystem timestamp (not a commit time or trusted clock).

There is no standard change-event subscription in the stable directory-handle API used here. Poll by re-enumerating the root, inbox directory, and message month directories; get file metadata to compare `size` and `lastModified`, and read message text only when the loader opens a message (currently new or unavailable entries). **Current cost is O(all inbox messages) metadata reads on every poll:** listing `inbox/` computes each month directory identity by inspecting its message metadata, then the loader may list a changed month again. Metadata calls are globally limited to six concurrent operations. There is no entry-count cap; work grows with the selected clone. A large clone can make polling expensive. Cap message reads at 1 MiB each, retain the current visible/hidden cadence (60 seconds/5 minutes), and make manual refresh invoke the same source refresh. Measuring and reducing duplicate metadata work on representative large fixtures is a follow-up before UI integration. The object handles returned by the platform do not expose a portable watcher. **Verified:** [File System Access spec](https://wicg.github.io/file-system-access/) leaves reflection of external filesystem changes to user-agent implementations; exact poll cost is an implementation inference, not a browser guarantee.

`DirectoryEntry.objectId` remains stable while the source observes unchanged file size and modification time. Local file identities are 32-bit FNV-1a hashes of that metadata; directory identities hash the sorted immediate child names and file metadata. These are not cryptographic content hashes. A collision can cause a month directory to be skipped during refresh; this is an accepted spike risk, not a production guarantee. Same-size edits within coarse timestamp resolution can also be missed. **Verified:** source behavior is covered by fake-handle tests; collision and timestamp risks follow from the selected metadata and hash.

The current loader identifies messages by filename and treats already-loaded messages as known. It will not replace a loaded message if that same path is edited in place. The spike proves initial parsing, not complete freshness. A follow-up must change the local refresh contract to replace changed entries (or explicitly establish immutable message files) before production integration. The source cannot reliably detect same-size edits when filesystem timestamp precision is coarse; a content digest would require reading every file and is not recommended for every poll.

The source currently returns a fresh `Head` on every poll, including when nothing changed. The loader therefore takes its full refresh path and republishes a snapshot each time; it returns zero new messages for an unchanged repository, so no new-message announcement should fire. Skipping unchanged snapshot publications would require a cheap, reliable local fingerprint and is not part of this spike. A UI slice should report the timestamp only after a successful scan and show a permission/read failure instead of advancing it.

## Security analysis

- **Read-only boundary:** request only `mode: "read"`; expose no write, delete, rename, or Git API. Skip entries whose kind is not `file` or `directory`; never follow link-like/unknown entries. The browser's entry kind and symlink behavior still need a Chromium acceptance test.
- **Paths and hostile names:** names originate in a user-controlled clone. Require repository-relative `/` paths with safe individual segments; reject empty, `.`/`..`, separators inside names, ASCII control characters, absolute paths, and paths outside `.agent-collab`, `inbox/`, or `topics/`. Ordinary spaces and Unicode are allowed. Render names as text. The spike omits unsafe names and refuses unsafe read paths. A host filename cannot escape its parent through string concatenation when handles are resolved one segment at a time.
- **Oversized files:** inspect `File.size` before calling `text()`; cap each read to 1 MiB. Oversize content becomes `too-large`, not a partially read message. A later UI must also avoid retaining arbitrarily many full contents at once.
- **Refs and previews:** refs are currently rendered as text; the viewer does not open topic files or attachments. If a later slice adds previews, accept only safe repository-relative `topics/` paths, split into validated segments, resolve through handles beneath the selected root, and reject schemes, absolute paths, backslashes, `.`/`..`, and encoded traversal. Do not turn message refs into arbitrary links or fetch targets. Encrypted bodies remain opaque and out of scope.
- **Symlinks:** the API surface exposes file/directory handles, not a portable `isSymlink` bit. The spike refuses any unknown kind and resolves children from their parent handles, never from an OS path. Whether the selected filesystem/provider presents a symlink as an ordinary file/directory or refuses it is **unverified** and must be tested on Chromium/OS combinations before claiming symlink containment. Do not claim the web API can identify every symlink.
- **CSP and egress:** current production policy is `connect-src https:` ([source](../../vite.config.ts)); this allows requests to arbitrary HTTPS endpoints. `LocalFolderSource` itself makes no requests, but CSP does not prove that all page code cannot exfiltrate text. On static Pages, use a separate document under a local-only path (for example `/agent-collab/local/`) with its own restrictive meta CSP before any script or data loads; a meta policy cannot be switched at runtime or loosen an earlier policy, and cannot set `frame-ancestors` ([CSP Level 3](https://www.w3.org/TR/CSP/), [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)). `connect-src 'none'` blocks common scripted network connections but does not block every egress path: top-level navigation, `window.open`, and WebRTC remain considerations. Keep `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, and `form-action 'none'`; test the complete policy. This is a production blocker to an absolute “never send folder contents over the network” claim. **Verified:** repository CSP checked in this spike; browser CSP effects are cited, and remaining channel analysis is an inference.
- **Other data flows:** never put file text or local paths in URLs, logs, analytics, errors, or persisted storage. Keep parsed content in memory. CSP does not prevent user-initiated navigation or browser extensions; the product claim should describe the app's behavior and threat model precisely.

## Fallback for browsers without a directory picker

Evaluate a small, separately installed local helper that exposes a read-only JSON/file-list endpoint on loopback, or a local copy of the viewer served from loopback. Bind only to loopback, allow only GET, allow exactly the deployed viewer origin in CORS, return no credentials, reject writes, cap response sizes, and return only the collaboration layout. CORS alone is not authorization and does not stop every cross-origin request; the helper needs an explicit pairing/origin defense and a dedicated threat review before shipping.

An HTTPS Pages viewer calling an HTTP helper on `localhost` is not a portable assumption. Chrome 142 introduced Local Network Access permission prompts for local/loopback requests from secure pages; Chrome's current guidance distinguishes `loopback-network` and `local-network`, and requires secure contexts. The permission and standard CORS are separate gates. Browser behavior outside Chromium—including Safari mixed-content handling, permission UX, and whether loopback is exempt in each release—is **unverified**. The existing CSP `connect-src https:` also blocks an HTTP loopback endpoint. A self-hosted HTTPS helper endpoint or serving the viewer locally can avoid some mixed-content constraints, but adds certificate/origin setup; it does not eliminate permission and CORS testing. **Verified:** [Chrome LNA launch note](https://developer.chrome.com/blog/local-network-access), [Chrome LNA guide](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access), and [Chrome 142 release notes](https://developer.chrome.com/release-notes/142).

## Existing sources and future UI

The composition root already selects concrete sources; UI and parser code depend on `MessageSource`. The local source can join that composition without provider details leaking into message parsing. The existing sources retain their distinct meanings: GitHub is remote and token/rate-limit aware, the demo is a fixed public snapshot, and the offline fixture is test/demo data. Do not silently switch a repository between them.

When UI work is authorized, use the existing icon toolbar as the source-picker entry point; settings can show or forget a repository's remembered source. The toolbar action selects the active source, while the remembered selection is restored per validated repository identity. Keep the local folder choice separate from GitHub credentials and never silently switch a repository between GitHub, the demo snapshot, the offline fixture, and the local clone. In the first hosted slice, keep the directory handle in memory and ask the user to pick the folder each session; do not persist it in IndexedDB until a dedicated origin is selected. Show an unsupported-browser explanation and a re-pick state. Do not add this in the spike. Validate `.agent-collab` before opening the viewer. Avoid changing the header toolbar, timeline, themes, or settings layout in this issue.

## Test strategy and unverified behavior

The spike uses an in-memory directory-handle fake and the existing `Loader`/message parser. Unit coverage checks nested monthly inbox traversal, hostile names, a symlink-like unknown entry, size caps, a file disappearing after listing, and permission errors. A browser test can inject a fake handle through a test-only factory seam; it must not replace the production picker or persist a fake handle.

Not verified here: native picker prompts, handle structured-clone/restart behavior, browser permission revocation UX, actual protected-directory refusal, filesystem symlink presentation, external edits/timestamp resolution, Chrome's LNA prompt against a real loopback helper, or non-Chromium helper behavior. A real-browser acceptance run for the first hosted slice should use a disposable synthetic clone with no private content; exercise first selection, cancel, re-pick after reload, permission denial/re-grant, revoke, protected-folder refusal, nested and large files, and an external edit during polling, while confirming no handle is persisted and no file content is transmitted. Record browser/OS versions and permission states. If a dedicated origin is approved later, add a separate acceptance case for IndexedDB handle serialization/restart and re-grant there.

## Slice plan and follow-up order

Sizes are rough effort estimates, not calendar promises.

1. **#16 spike (S, this change):** decision record and isolated source implementation/tests. No UI or persistence.
2. **Dedicated origin and CSP (M):** decide whether to use a dedicated custom origin, then serve a local-only document with an early CSP; until then retain in-memory handles only and re-pick each session.
3. **Local freshness and scan cost (M):** reconcile same-path edits, metadata collisions, repeated unchanged publication, duplicate metadata scans, page size, and refresh announcements; add large-fixture measurements.
4. **Source choice and permission lifecycle (M):** browser feature detection, picker user gesture, in-memory per-session handle, unsupported/re-pick states, and per-repository source choice. Add IndexedDB handle storage only after the dedicated-origin decision.
5. **Chromium acceptance (S/M):** add real-browser picker, protected-directory and permission tests on disposable data and complete the acceptance matrix above.
6. **Helper fallback decision (L):** only if non-picker browser demand warrants it; choose local viewer versus helper, then test LNA, CORS, mixed content, and pairing defenses across target browsers.
7. **Topic/attachment preview (M, separate issue if desired):** only after a product need; implement segment-safe handle resolution and preview limits.

No fallback helper or topic preview is part of this spike.

## Implemented behavior (slices 3 and 4)

- **Source choice.** The welcome screen and the toolbar of an open viewer offer a local folder, only
  where `window.showDirectoryPicker` exists; elsewhere the welcome screen explains that a browser
  with folder access is needed and the toolbar has no folder button. The picker runs straight from
  the click with `mode: "read"`. Cancelling or a refused folder shows the neutral message; a folder
  without `.agent-collab` is refused before the viewer opens. **Remembering (issue #53).** A folder
  picked with the directory picker is remembered across a reload: the handle and its display name
  (nothing else: no path, no content) go to IndexedDB through the guarded record store
  (`src/source/folder-memory.ts`); a store that is blocked or throws just remembers nothing. One
  folder is kept, and picking another replaces it. After a reload the viewer returns to the folder
  when it was the last viewer shown and `queryPermission({ mode: "read" })` says `granted`; otherwise
  the welcome screen offers "Reopen <name>", which calls `requestPermission` from the click, and
  "Forget this folder". A folder that was deleted or whose permission is refused shows the local
  error message and the reader chooses the folder again. A snapshot from a file input (a FileList)
  cannot be remembered and its notice says so. The reader's choices for a folder (Viewing as,
  colours, names, selected view and topic) are kept under `local:<folder name>`, so two folders with
  the same name share them; never a path. A revoked permission stops the read with the
  `forbidden` message and keeps the messages on screen; choosing the folder again recovers.
- **Label.** The source is shown as "Local folder · experimental" until the dedicated-origin and CSP
  slice lands. The viewer keeps the reader's choices for a local folder
  (Viewing as, colours, local names, the selected view and topic) under `local:<folder name>` in
  the guarded browser storage; two folders with the same name share them. The key holds the
  display name only, never a path, and the folder handle itself is not stored.
- **One scan per poll.** A poll walks the root, the inbox and its month folders once and reads each
  file's metadata once; deeper directories are listed but not walked. At most 50,000 entries are
  enumerated per scan: a larger or hostile folder (very deep, or hundreds of thousands of files)
  fails with a neutral "too large" state instead of hanging, and the entry-count cap replaces the
  spike's "no entry-count cap". A poll that arrives while a scan is still running shares it, so a
  scan slower than the interval never overlaps itself. The revision covers the whole scan, so an unchanged folder answers
  "not modified": the loader lists nothing, reads nothing and does not republish. Listings for the
  same revision come from the scan, so the loader's later requests cost no further metadata reads.
  Topic files are not scanned; they are read when an attachment card is opened, and entries carry
  their size.
- **Edits in place.** Identities are 53-bit hashes of size and modification time (directories hash
  their children), so an edited file changes its directory and the loader replaces the loaded item;
  it is not counted as a new arrival. Same-size edits within the filesystem's timestamp precision can
  still be missed (accepted); a 53-bit hash makes an accidental collision very unlikely.
- **Last change.** The newest file modification time of the marker and message files in the latest
  successful scan (topic files are not scanned); a time more than a day in the future is ignored as
  clock skew, so a far-future file cannot pin the indicator to "just now", shown near the
  source name as relative text with the exact time on hover and no warning thresholds. A failed scan
  does not advance it.
- **Measurement.** `tests/local-folder.test.ts` builds a clone of 3,000 messages in 24 month folders
  and counts calls on the handle fake: an unchanged poll costs exactly 3,001 metadata reads (one per
  file, plus the marker), 26 directory enumerations (root, inbox, 24 months) and zero content
  reads. Deleting or renaming a file changes the revision; a loaded message is never removed (the
  inbox is an append-only log), and a renamed file arrives as a new message. Before this change the same poll cost a metadata walk for the inbox listing, another for
  each month listing, and a full republish. Measured timings on real disks are part of the
  Chromium acceptance slice.
