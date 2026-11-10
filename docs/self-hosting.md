# Self-hosting the static viewer

The viewer can be built as a static image and served without an application API,
agent daemon, workspace mount, or server-side credential. The anonymous demo and
the browser's existing repository authorization behave the same as in the
regular web build.

## Build and run with Compose

The `static-viewer` Compose profile is disabled by default. Start it explicitly:

```sh
docker compose --profile static-viewer up --build -d
```

The service listens on container port `8080`, published on host port `8080` by
default. Set `AGENT_COLLAB_PORT` to choose another host port. The health endpoint
is `/healthz`.

To serve from a subpath, set `VITE_BASE_PATH` when building the image. It must
start and end with `/` and contain only letters, numbers, hyphens, or
underscores between slashes. For example:

```sh
VITE_BASE_PATH=/agent-collab/ AGENT_COLLAB_PORT=8080 \
  docker compose --profile static-viewer up --build -d
```

Open `/agent-collab/?demo` on the selected host port. The same base path is used
for generated asset URLs, deep-link refresh fallback, and direct asset serving.
Changing it requires rebuilding the image.

## Build the image directly

```sh
docker build --build-arg VITE_BASE_PATH=/ -t agent-collab-viewer:local .
docker run --rm -p 8080:8080 agent-collab-viewer:local
```

The build stage installs dependencies with the committed `pnpm-lock.yaml` using
`--frozen-lockfile`. Both the `node:24-alpine` build image and
`nginxinc/nginx-unprivileged:1.29-alpine` runtime image are pinned by registry
digest. The runtime stage serves only the generated static files.

The image contains no credential or agent state. For a private repository, the
viewer continues to use its existing browser-side authorization mechanism; no
credential is passed to the container.

If `public/demo-snapshot.json` is present in the build context, the normal Vite
build copies that static snapshot into the image. Without it, the anonymous
`?demo` view continues to use the app's bundled synthetic fixture.
