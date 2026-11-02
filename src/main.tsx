import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { demoFiles } from "./demo/fixtures";
import { Loader } from "./loader/loader";
import { FixtureSource } from "./source/fixture";
import { App } from "./ui/App";
import "./ui/styles.css";

// Composition root. Until the settings screen exists, the app shows the synthetic demo repository.
const loader = new Loader(new FixtureSource(demoFiles));
const root = document.getElementById("root");
if (root === null) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <App loader={loader} title="Demo repository" selfNames={new Set(["alice-agent"])} />
  </StrictMode>,
);
