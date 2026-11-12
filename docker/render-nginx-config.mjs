import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const templatePath = fileURLToPath(new URL("./nginx.conf.template", import.meta.url));

export function renderNginxConfig(basePath) {
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(basePath)) {
    throw new Error(
      "VITE_BASE_PATH must be / or a slash-delimited path containing letters, numbers, _ or -",
    );
  }

  const basePathLocation =
    basePath === "/"
      ? ""
      : `location ^~ ${basePath} {\n        rewrite ^${basePath}(.*)$ /$1 break;\n        try_files $uri $uri/ /index.html;\n    }`;

  return readFileSync(templatePath, "utf8")
    .replace("__SNAPSHOT_PATH__", `${basePath}hosted-snapshot.json`)
    .replace("__BASE_PATH_LOCATION__", basePathLocation);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(renderNginxConfig(process.argv[2] ?? "/"));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
