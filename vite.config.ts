import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Content Security Policy for the built page (docs/design.md, section 6). Only the
// build gets it: the dev server injects inline scripts for hot reload.
const CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; " +
  "connect-src https:";

const contentSecurityPolicy: Plugin = {
  name: "content-security-policy",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
      injectTo: "head-prepend",
    },
  ],
};

export default defineConfig(({ command }) => ({
  // The deployment path applies to production output only; local dev stays at "/".
  base: command === "build" ? (process.env.VITE_BASE_PATH ?? "/") : "/",
  plugins: [react(), contentSecurityPolicy],
  server: { strictPort: true },
  clearScreen: false,
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
  },
}));
