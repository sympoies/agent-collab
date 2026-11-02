import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import type { Secret } from "./credentials/secret";
import { BrowserEncryptedStore, indexedDbRecords, MemoryStore } from "./credentials/store";
import { demoFiles } from "./demo/fixtures";
import type { ViewerSettings } from "./settings/model";
import { FixtureSource } from "./source/fixture";
import { GitHubSource } from "./source/github";
import type { MessageSource } from "./source/types";
import { Root } from "./ui/Root";
import "./ui/styles.css";

// Composition root: the only module that picks concrete providers and stores.

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

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <Root
      storage={window.localStorage}
      stores={{
        memory: new MemoryStore(),
        "browser-encrypted": new BrowserEncryptedStore(indexedDbRecords()),
      }}
      createSource={createSource}
      createDemoSource={() => new FixtureSource(demoFiles)}
    />
  </StrictMode>,
);
