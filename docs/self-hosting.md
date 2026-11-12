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

## Use the published image

A version tag (`v1.2.3`) triggers the release workflow, which builds the image for
`linux/amd64` and `linux/arm64`, smoke-tests each platform with the acceptance
script below, and only then pushes it to
`ghcr.io/sympoies/agent-collab-viewer:1.2.3`. The pushed digest is written to the
workflow's job summary and to an `image-digest` artifact. There is no `latest`
tag: a moving tag makes an upgrade invisible, so pin a version or, better, the
digest.

```sh
docker run --rm -p 127.0.0.1:8080:8080 \
  ghcr.io/sympoies/agent-collab-viewer:1.2.3
```

The published image is built with the default base path `/`. To serve it under a
subpath, build the image yourself with `VITE_BASE_PATH`, or let a reverse proxy
own the subpath and strip it before forwarding.

## Serve your own snapshot

The viewer looks for `hosted-snapshot.json` next to the page (see
[Serve a snapshot of a clone](getting-started.md#serve-a-snapshot-of-a-clone)).
The image serves that file from an optional read-only mount at `/srv/snapshot`:

```sh
docker run --rm -p 127.0.0.1:8080:8080 \
  -v /path/to/snapshot-dir:/srv/snapshot:ro \
  ghcr.io/sympoies/agent-collab-viewer:1.2.3
```

- The file is served at `<base path>hosted-snapshot.json` with
  `Cache-Control: no-store`, so every refresh fetches the current copy.
- Mount the **directory**, not the single file. The snapshot script replaces the
  file atomically, which a single-file bind mount would not follow.
- The container runs as an unprivileged user, so the directory and file must be
  readable by everyone (`chmod 755` and `chmod 644`).
- With nothing mounted, or no file in the mount, the path answers `404`. The image
  needs no mount to run, and the snapshot is never copied into an image layer:
  `.dockerignore` excludes `hosted-snapshot.json` from the build context.

With Compose, add the mount in an override file (it is deliberately not part of the
shipped `compose.yaml`):

```yaml
services:
  static-viewer:
    volumes:
      - /path/to/snapshot-dir:/srv/snapshot:ro
```

## Keep a private snapshot private

The snapshot holds the repository's messages and is served to anyone who can reach
the container. The image has no authentication of its own, so put access control
in front of it:

- Publish the container port on a private interface only
  (`-p 127.0.0.1:8080:8080`, or a private network name instead of a published port).
- Reach it through an existing reverse proxy that authenticates readers, or only
  over a VPN or other private network. For example, with nginx as the proxy:

  ```nginx
  server {
      listen 443 ssl;
      server_name viewer.example.com;
      # TLS and an authentication method of your choice go here.

      location / {
          proxy_pass http://127.0.0.1:8080;
      }
  }
  ```

  Keep the image's base path and the proxy's path the same, or serve the image at `/`
  and let the proxy map a subpath to it.

## Verify an image

`scripts/verify-static-image.sh <image-ref> [base-path]` is the acceptance check for
any image reference, local or from a registry. `base-path` is the value the image was
built with (default `/`). It needs Docker, `curl`, `tar` and `grep`.

```sh
scripts/verify-static-image.sh ghcr.io/sympoies/agent-collab-viewer:1.2.3
scripts/verify-static-image.sh agent-collab-viewer:local /agent-collab/
```

It runs the image with no mounts and checks `/healthz`, the base path, a built asset,
the deep-link fallback, that no snapshot is served, that the container runs as a
non-root user, and that the image history, configuration and layers hold no
credential-like strings, credential files or snapshot data. It then runs the image
again with a temporary snapshot mounted read-only and checks that the snapshot is
served with `no-store` and that the mount is configured read-only. Output lists one `PASS` or
`FAIL` line per check; it never prints a matched value, only which check matched.

It also prints the image digest (a local image has no registry digest yet, so the
local image id is shown instead) and the source revision recorded in the image's
`org.opencontainers.image.revision` label, so a record of the run identifies exactly
what was verified. The exit status is non-zero if any check fails. The release
workflow runs the same script on each platform before it publishes.
