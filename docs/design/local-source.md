# Local clone source: design decision

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

1. **First grant:** from a visible user action, call `showDirectoryPicker({ mode: "read" })`. The browser opens its native picker; the user chooses a directory. The picker requires a secure context and transient user activation. If dismissed, report cancellation without changing the current source. No write permission is requested. **Verified:** [MDN picker documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker).
2. **Remembering a choice:** structured-clone the returned directory handle into IndexedDB only after an explicit “remember this folder” choice. Keep the handle scoped by repository identity and origin. The handle's serializability is documented by [Chrome](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) and [MDN](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API). IndexedDB is browser-managed storage and may be cleared or evicted; it is not a durable backup. Do not store file contents or permission claims as a substitute for querying the handle.
3. **Later use/restart:** load the handle and call `queryPermission({ mode: "read" })`. A stored handle may report `prompt` after browser restart or profile/session changes. When state is `prompt`, explain that access needs renewal and call `requestPermission({ mode: "read" })` only from a fresh user action. A background poll cannot request permission. **Verified:** [MDN permission documentation](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/queryPermission) and the [File System Access permission lifecycle](https://wicg.github.io/file-system-access/#api-filesystemhandle-querypermission).
4. **Revoked/denied:** stop reading and polling, preserve the selected source record as unavailable, and offer a user-initiated re-grant or folder replacement. Map permission failures to a safe `forbidden` source error; do not surface browser exception text or local paths. The lifecycle is browser-defined; this UI response is the recommendation.

The picker may refuse directories deemed too sensitive or dangerous. The File System Access specification gives examples: browser profile/storage, operating-system files (including `/dev`, `/sys`, `/proc` and Windows system directories), the whole home directory, and the whole Downloads directory. These are examples of user-agent restrictions, not a portable, exhaustive denylist. Say “the browser does not allow this folder; choose the clone directory itself,” and do not guess the user's OS path. **Verified:** [picker exception documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker) and [spec privacy guidance](https://wicg.github.io/file-system-access/#privacy-considerations).

## Read model, refresh and cost

Read only the selected working tree. This deliberately includes uncommitted changes; Git history would be slower and could disagree with what agents currently see. A stale clone remains stale. The UI should identify the chosen source as a local working tree and show “last file change seen” using the newest observed file `lastModified` time, qualified as a local filesystem timestamp (not a commit time or trusted clock).

There is no standard change-event subscription in the stable directory-handle API used here. Poll by re-enumerating the root, inbox directory, and message month directories; get file metadata to compare `size` and `lastModified`, and read content only when the loader opens a message (currently new or unavailable entries). This costs O(number of inbox entries) directory/metadata operations per poll and O(number of requested files) content reads. Metadata lookup uses a concurrency limit of six. A huge clone can make polling expensive; cap message reads at 1 MiB each, keep the existing visible/hidden poll cadence (60 seconds/5 minutes), and make manual refresh invoke the same source refresh. No fixed count cap is proposed without a real repository-size measurement. The object handles returned by the platform do not expose a portable watcher. **Verified:** [File System Access spec](https://wicg.github.io/file-system-access/) leaves reflection of external filesystem changes to user-agent implementations; exact poll cost is an implementation inference, not a browser guarantee.

`DirectoryEntry.objectId` remains stable while the source observes unchanged file size and modification time. Local file identities are bounded hashes of that metadata; directory identities are hashes of the sorted immediate child names and file metadata. These are validators, not cryptographic content hashes. Same-size edits within coarse timestamp resolution can therefore be missed. **Verified:** the source behavior is covered by fake-handle tests; timestamp collision risk is an inference from the metadata chosen.

The current loader identifies messages by filename and treats already-loaded messages as known. It will not replace a loaded message if that same path is edited in place. The spike proves initial parsing, not complete freshness. A follow-up must change the local refresh contract to replace changed entries (or explicitly establish immutable message files) before production integration. The source cannot reliably detect same-size edits when filesystem timestamp precision is coarse; a content digest would require reading every file and is not recommended for every poll.

The source emits no event for an unchanged poll. Existing loader refresh announcements should remain limited to newly observed messages. Announcing “checked” every poll would be noisy. A UI slice should report the timestamp only after a successful scan, and show a permission/read failure instead of advancing it.

## Security analysis

- **Read-only boundary:** request only `mode: "read"`; expose no write, delete, rename, or Git API. Skip entries whose kind is not `file` or `directory`; never follow link-like/unknown entries. The browser's entry kind and symlink behavior still need a Chromium acceptance test.
- **Paths and hostile names:** names originate in a user-controlled clone. Require repository-relative `/` paths with safe individual segments; reject empty, `.`/`..`, separators inside names, absolute paths, and paths outside `.agent-collab`, `inbox/`, or `topics/`. Render names as text. The spike omits unsafe names and refuses unsafe read paths. A host filename cannot escape its parent through string concatenation when handles are resolved one segment at a time.
- **Oversized files:** inspect `File.size` before calling `text()`; cap each read to 1 MiB. Oversize content becomes `too-large`, not a partially read message. A later UI must also avoid retaining arbitrarily many full contents at once.
- **Refs and previews:** refs are currently rendered as text; the viewer does not open topic files or attachments. If a later slice adds previews, accept only safe repository-relative `topics/` paths, split into validated segments, resolve through handles beneath the selected root, and reject schemes, absolute paths, backslashes, `.`/`..`, and encoded traversal. Do not turn message refs into arbitrary links or fetch targets. Encrypted bodies remain opaque and out of scope.
- **Symlinks:** the API surface exposes file/directory handles, not a portable `isSymlink` bit. The spike refuses any unknown kind and resolves children from their parent handles, never from an OS path. Whether the selected filesystem/provider presents a symlink as an ordinary file/directory or refuses it is **unverified** and must be tested on Chromium/OS combinations before claiming symlink containment. Do not claim the web API can identify every symlink.
- **CSP and egress:** current production policy is `connect-src https:` ([source](../../vite.config.ts)); this allows requests to arbitrary HTTPS endpoints. `LocalFolderSource` itself makes no requests, but CSP does not prove that all page code cannot exfiltrate text. Before enabling local handles, use a local-mode response/build policy with `connect-src 'none'` (and retain `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`), or document a reviewed narrower endpoint model. The current static CSP cannot switch after the page is loaded. This is a production blocker to an absolute “never send folder contents over the network” claim. **Verified:** repository CSP checked in this spike; consequences are CSP semantics/inference.
- **Other data flows:** never put file text or local paths in URLs, logs, analytics, errors, or persisted storage. Keep parsed content in memory. CSP does not prevent user-initiated navigation or browser extensions; the product claim should describe the app's behavior and threat model precisely.

## Fallback for browsers without a directory picker

Evaluate a small, separately installed local helper that exposes a read-only JSON/file-list endpoint on loopback, or a local copy of the viewer served from loopback. Bind only to loopback, allow only GET, allow exactly the deployed viewer origin in CORS, return no credentials, reject writes, cap response sizes, and return only the collaboration layout. CORS alone is not authorization and does not stop every cross-origin request; the helper needs an explicit pairing/origin defense and a dedicated threat review before shipping.

An HTTPS Pages viewer calling an HTTP helper on `localhost` is not a portable assumption. Chrome 142 introduced Local Network Access permission prompts for local/loopback requests from secure pages; Chrome's current guidance distinguishes `loopback-network` and `local-network`, and requires secure contexts. The permission and standard CORS are separate gates. Browser behavior outside Chromium—including Safari mixed-content handling, permission UX, and whether loopback is exempt in each release—is **unverified**. The existing CSP `connect-src https:` also blocks an HTTP loopback endpoint. A self-hosted HTTPS helper endpoint or serving the viewer locally can avoid some mixed-content constraints, but adds certificate/origin setup; it does not eliminate permission and CORS testing. **Verified:** [Chrome LNA launch note](https://developer.chrome.com/blog/local-network-access), [Chrome LNA guide](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access), and [Chrome 142 release notes](https://developer.chrome.com/release-notes/142).

## Existing sources and future UI

The composition root already selects concrete sources; UI and parser code depend on `MessageSource`. The local source can join that composition without provider details leaking into message parsing. The existing sources retain their distinct meanings: GitHub is remote and token/rate-limit aware, the demo is a fixed public snapshot, and the offline fixture is test/demo data. Do not silently switch a repository between them.

When UI work is authorized, use the existing icon toolbar as the source-picker entry point; settings can show or forget the remembered source/handle for a repository. The toolbar action selects the active source, while the remembered selection is restored per validated repository identity. Keep the local folder choice separate from GitHub credentials and never silently switch a repository between GitHub, the demo snapshot, the offline fixture, and the local clone. Show an unsupported-browser explanation and a re-grant state. Do not add this in the spike. A handle must not be associated with a different repository identity based only on a display name; validate `.agent-collab` before opening the viewer. Avoid changing the header toolbar, timeline, themes, or settings layout in this issue.

## Test strategy and unverified behavior

The spike uses an in-memory directory-handle fake and the existing `Loader`/message parser. Unit coverage checks nested monthly inbox traversal, hostile names, a symlink-like unknown entry, size caps, a file disappearing after listing, and permission errors. A browser test can inject a fake handle through a test-only factory seam; it must not replace the production picker or persist a fake handle.

Not verified here: native picker prompts, handle structured-clone/restart behavior, browser permission revocation UX, actual protected-directory refusal, filesystem symlink presentation, external edits/timestamp resolution, Chrome's LNA prompt against a real loopback helper, or non-Chromium helper behavior. A real-browser acceptance run should use a disposable synthetic clone with no private content; exercise first selection, cancel, restart with IndexedDB handle, prompt/re-grant, revoke, protected folder refusal, nested and large files, an external edit during polling, and local-helper requests from Chrome, Firefox, and Safari where available. Record browser/OS versions and permission states, and confirm no file content is transmitted.

## Slice plan and follow-up order

Sizes are rough effort estimates, not calendar promises.

1. **#16 spike (S, this change):** decision record and isolated source implementation/tests. No UI or persistence.
2. **Local-mode egress policy (M):** define how deployed/local builds can apply an enforceable CSP before loading source data; prove the chosen policy does not permit arbitrary outbound requests.
3. **Local freshness (M):** reconcile metadata polling with loader replacement of changed filenames, timestamp limits, page size and refresh announcements; measure on representative large fixtures.
4. **Source choice and permission lifecycle (M):** browser feature detection, picker user gesture, explicit IndexedDB handle storage, per-repository association, re-grant and revoke states. Keep existing source behavior intact.
5. **Chromium acceptance (S/M):** add real-browser picker/IndexedDB/permission tests on disposable data and complete the acceptance matrix above.
6. **Helper fallback decision (L):** only if non-picker browser demand warrants it; choose local viewer versus helper, then test LNA, CORS, mixed content, and pairing defenses across target browsers.
7. **Topic/attachment preview (M, separate issue if desired):** only after a product need; implement segment-safe handle resolution and preview limits.

No fallback helper or topic preview is part of this spike.
