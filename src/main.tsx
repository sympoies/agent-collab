import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import type { Secret } from "./credentials/secret";
import { BrowserEncryptedStore, indexedDbRecords, MemoryStore } from "./credentials/store";
import { demoFiles } from "./demo/fixtures";
import type { ViewerSettings } from "./settings/model";
import { FixtureSource } from "./source/fixture";
import { LocalFolderSource, type LocalDirectoryHandle } from "./source/local-folder";
import { GitHubSource } from "./source/github";
import { CachedDemoSource } from "./source/cached-demo";
import { HostedSnapshotSource } from "./source/hosted-snapshot";
import { readHostedSnapshot } from "./settings/demo-snapshot";
import type { MessageSource } from "./source/types";
import { Root } from "./ui/Root";
import { LocaleProvider } from "./i18n/LocaleProvider";
import { ThemeProvider } from "./ui/ThemeProvider";
import "./ui/styles.css";

// Composition root: the only module that picks concrete providers and stores.

function safeBrowserStorage(): Pick<Storage, "getItem" | "setItem"> {
  const fallback = new Map<string, string>();
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    // Storage can be unavailable in sandboxed or privacy-restricted contexts.
  }

  return {
    getItem(key) {
      if (fallback.has(key)) return fallback.get(key) ?? null;
      if (storage !== null) {
        try {
          return storage.getItem(key);
        } catch {
          return fallback.get(key) ?? null;
        }
      }
      return fallback.get(key) ?? null;
    },
    setItem(key, value) {
      if (storage !== null) {
        try {
          storage.setItem(key, value);
          fallback.delete(key);
          return;
        } catch {
          // Keep this key usable in memory without disabling other settings.
        }
      }
      fallback.set(key, value);
    },
  };
}

function createSource(settings: ViewerSettings, token: Secret): MessageSource {
  switch (settings.platform) {
    case "github": {
      const [owner = "", repo = ""] = settings.repository.split("/");
      return new GitHubSource({
        apiBase: settings.endpoint,
        owner,
        repo,
        branch: settings.branch === "" ? null : settings.branch,
        token,
      });
    }
    case "gitlab":
      throw new Error("GitLab support is not available yet.");
  }
}

function createLiveDemoSource(token: Secret | null): MessageSource {
  const source = new GitHubSource({
    apiBase: "https://api.github.com",
    owner: "sympoies",
    repo: "agent-collab-demo",
    branch: null,
    token,
  });
  let storage: Pick<Storage, "getItem" | "setItem"> | null = null;
  try {
    storage = window.localStorage;
  } catch {
    // Public demo blob caching is optional.
  }
  return new CachedDemoSource(source, storage);
}

/**
 * The browser's folder picker, or null where it does not exist (Firefox, Safari, insecure pages).
 * It must be called straight from a click; the handle stays in memory and is never stored.
 */
function folderPicker(): (() => Promise<{ source: MessageSource; name: string }>) | null {
  const picker = (
    window as { showDirectoryPicker?: (options: { mode: "read" }) => Promise<LocalDirectoryHandle> }
  ).showDirectoryPicker;
  if (typeof picker !== "function") return null;
  return async () => {
    const handle = await picker.call(window, { mode: "read" });
    return { source: new LocalFolderSource(handle), name: handle.name };
  };
}

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root element");
const storage = safeBrowserStorage();

// A deployment that serves a snapshot next to the app (docs/getting-started.md) opens it directly.
const hosted = (await readHostedSnapshot()) === null ? null : () => new HostedSnapshotSource();

createRoot(root).render(
  <StrictMode>
    <LocaleProvider storage={storage}>
      <ThemeProvider storage={storage}>
        <Root
          storage={storage}
          stores={{
            memory: new MemoryStore(),
            "browser-encrypted": new BrowserEncryptedStore(indexedDbRecords()),
          }}
          createSource={createSource}
          createDemoSource={() => new FixtureSource(demoFiles)}
          createLiveDemoSource={createLiveDemoSource}
          openLocalFolder={folderPicker()}
          createHostedSource={hosted}
        />
      </ThemeProvider>
    </LocaleProvider>
  </StrictMode>,
);
