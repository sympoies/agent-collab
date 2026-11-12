#!/usr/bin/env bash
# Acceptance checks for a static viewer image.
#
#   scripts/verify-static-image.sh <image-ref> [base-path]
#
# <image-ref> is a local or registry image reference. [base-path] is the VITE_BASE_PATH the image
# was built with (default "/"). The script runs the image with no mounts and checks health, the base
# path, the deep-link SPA fallback, a non-root user, and that the image holds no credential-like
# strings or snapshot files. It then checks the optional snapshot mount: served when mounted, 404
# when not. It prints the image digest and the source revision label, exits non-zero on any
# failure, and never prints a matched secret value (only the name of the check that matched).
# Requires: docker, curl, tar, grep.

# Check functions are called indirectly through `check`, and cleanup through the EXIT trap.
# shellcheck disable=SC2317
set -uo pipefail

usage() {
  echo "usage: verify-static-image.sh <image-ref> [base-path]" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
image=$1
base=${2:-/}
if [[ ! $base =~ ^/([a-zA-Z0-9_-]+/)*$ ]]; then
  echo "verify-static-image.sh: invalid base path '$base' (use / or /name/, letters, digits, _ and -)" >&2
  exit 2
fi
if [[ -z $image || $image == -* ]]; then
  usage
fi

for tool in docker curl tar grep; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "verify-static-image.sh: required tool not found: $tool" >&2
    exit 2
  }
done

work=$(mktemp -d)
run_id="verify-static-image-$$"
failures=0

cleanup() {
  docker rm -f "$run_id-plain" "$run_id-mounted" >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

pass() { echo "PASS  $1"; }
fail() {
  echo "FAIL  $1"
  failures=$((failures + 1))
}
check() { # check <description> <command...>
  local description=$1
  shift
  if "$@"; then pass "$description"; else fail "$description"; fi
}

if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker pull --quiet "$image" >/dev/null 2>&1 || {
    echo "verify-static-image.sh: image not found locally and could not be pulled: $image" >&2
    exit 2
  }
fi

# start_container <name> [extra docker run args...]; prints the loopback URL of the published port.
start_container() {
  local name=$1
  shift
  docker run -d --name "$name" -p 127.0.0.1::8080 "$@" "$image" >/dev/null || return 1
  local port
  port=$(docker port "$name" 8080/tcp | head -n 1 | sed 's/.*://')
  [[ -n $port ]] || return 1
  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/healthz" 2>/dev/null; then
      echo "http://127.0.0.1:$port"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

status_of() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
body_has_shell() { # body_has_shell <url> <file>: 200 and the app root element
  [[ $(curl -s -o "$2" -w '%{http_code}' "$1") == 200 ]] && grep -q '<div id="root"' "$2"
}
is_ok() { [[ $(curl -s "$1") == ok ]]; }
is_status() { [[ $(status_of "$1") == "$2" ]]; }
is_nonroot() { [[ -n $1 && $1 != 0 && $1 != root ]]; }
serves_text() { [[ $(curl -s "$1") == *"$2"* ]]; }
has_no_store() { curl -sI "$1" | tr -d '\r' | grep -qiE '^cache-control:[[:space:]]*no-store$'; }
# The mount's own read-write flag, not a write attempt: an unprivileged user could not write to the
# host directory anyway, so a failed write would not prove the mount is read-only.
is_read_only() {
  [[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/srv/snapshot"}}{{.RW}}{{end}}{{end}}' "$1") == false ]]
}
lacks_pattern() { ! grep -qE "$1" "$2"; } # lacks_pattern <regex> <file>
no_credential_env() {
  ! docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" |
    grep -qiE '^[^=]*(token|secret|password|passwd|credential|api_?key)[^=]*='
}

echo "image:      $image"
digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$image" 2>/dev/null)
if [[ -z $digest || $digest == "<no value>" ]]; then
  digest="none (local image, id $(docker image inspect --format '{{.Id}}' "$image"))"
fi
revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image" 2>/dev/null)
[[ -n $revision && $revision != "<no value>" ]] || revision="not set"
echo "digest:     $digest"
echo "source sha: $revision"
echo "base path:  $base"
echo

# --- Run with no mounts -------------------------------------------------------------------------
if ! url=$(start_container "$run_id-plain"); then
  fail "container starts with no mounts and /healthz answers"
  docker logs "$run_id-plain" 2>&1 | tail -n 5
  echo
  echo "RESULT: FAILED ($failures failed)"
  exit 1
fi
pass "container starts with no mounts and /healthz answers"
plain=$run_id-plain

check "/healthz returns 200 ok" is_ok "$url/healthz"

index_body="$work/index.html"
check "base path $base serves the app shell" body_has_shell "$url$base" "$index_body"

asset=$(grep -oE "(src|href)=\"${base}assets/[^\"]+\.js\"" "$index_body" | head -n 1 | sed -E 's/^[a-z]+="//; s/"$//')
if [[ -n $asset ]]; then
  check "built asset is served under the base path ($asset)" is_status "$url$asset" 200
else
  fail "index page references a built script under ${base}assets/"
fi

deep="${base}t/some-topic/deep-link"
check "deep link $deep falls back to the app shell" body_has_shell "$url$deep" "$work/deep.html"
check "no snapshot is served when none is mounted (404)" is_status "$url${base}hosted-snapshot.json" 404

# --- Non-root -----------------------------------------------------------------------------------
uid=$(docker exec "$plain" id -u 2>/dev/null)
check "container runs as non-root (uid ${uid:-unknown})" is_nonroot "$uid"
check "image declares a non-root default user" is_nonroot "$(docker image inspect --format '{{.Config.User}}' "$image" 2>/dev/null)"

# --- Layers and history -------------------------------------------------------------------------
# Patterns are tested with grep -q so a match is reported by name only, never printed.
secret_names=(github-token github-fine-grained-token github-app-token private-key aws-key-id registry-auth)
secret_patterns=(
  'gh[pousr]_[A-Za-z0-9]{36,}'
  'github_pat_[A-Za-z0-9_]{22,}'
  'ghs_[A-Za-z0-9]{36,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'AKIA[0-9A-Z]{16}'
  '"auth":[[:space:]]*"[A-Za-z0-9+/=]{16,}"'
)

scan_text() { # scan_text <label> <file>: reports pattern names that match, never the match
  local label=$1 file=$2 index found=0
  for index in "${!secret_patterns[@]}"; do
    if grep -qE -- "${secret_patterns[$index]}" "$file"; then
      echo "      credential-like string (${secret_names[$index]}) in $label"
      found=1
    fi
  done
  [[ $found -eq 0 ]]
}

meta="$work/meta.txt"
{
  docker history --no-trunc --format '{{.CreatedBy}}' "$image"
  docker image inspect --format '{{json .Config}}' "$image"
} >"$meta" 2>&1
check "image history and config hold no credential-like strings" scan_text "image history/config" "$meta"
check "image config sets no credential-named environment variable" no_credential_env

layers="$work/layers"
mkdir -p "$layers"
if docker save "$image" -o "$work/image.tar" && tar -xf "$work/image.tar" -C "$layers"; then
  pass "image exported for layer inspection"
  layer_listing="$work/layer-files.txt"
  : >"$layer_listing"
  extracted="$work/extracted"
  mkdir -p "$extracted"
  while IFS= read -r blob; do
    # JSON blobs (config, manifests) are not tar archives; tar rejects them quietly here.
    if tar -tf "$blob" >>"$layer_listing" 2>/dev/null; then
      tar -xf "$blob" -C "$extracted" --exclude='dev/*' 2>/dev/null || true
    fi
  done < <(find "$layers" -type f \( -path '*/blobs/*' -o -name 'layer.tar' \))
  if [[ -s $layer_listing ]]; then
    pass "layer contents listed"
  else
    fail "layer contents listed"
  fi
  # A built-in public/demo-snapshot.json is allowed (see the self-hosting guide); the hosted
  # snapshot and anything under /srv/snapshot never are.
  # A built-in public/demo-snapshot.json is allowed (see the self-hosting guide); the hosted
  # snapshot and anything under /srv/snapshot never are.
  check "no hosted snapshot data in any layer" lacks_pattern '(^|/)hosted-snapshot\.json$|^(\./)?srv/snapshot/.' "$layer_listing"
  # The base image ships public CA certificates (*.pem) under etc/ssl; those are not credentials.
  grep -vE '^(\./)?(etc/ssl[0-9.]*|usr/share/ca-certificates)/' "$layer_listing" >"$work/private-listing.txt"
  check "no credential or local-state files in any layer" lacks_pattern '(^|/)(\.env(\..*)?|\.npmrc|\.git|id_rsa|id_ed25519|[^/]+\.pem|[^/]+\.key)(/|$)' "$work/private-listing.txt"
  contents="$work/contents.txt"
  find "$extracted" -type f -size -2M -print0 2>/dev/null | xargs -0 cat -- >"$contents" 2>/dev/null
  check "layer file contents hold no credential-like strings" scan_text "layer contents" "$contents"
else
  fail "image exported for layer inspection"
fi

# --- Optional snapshot mount ----------------------------------------------------------------------
snapshot_dir="$work/snapshot"
mkdir -p "$snapshot_dir"
chmod 755 "$snapshot_dir"
marker="verify-static-image-$$-marker"
printf '{"marker":"%s"}\n' "$marker" >"$snapshot_dir/hosted-snapshot.json"
chmod 644 "$snapshot_dir/hosted-snapshot.json"

if mounted_url=$(start_container "$run_id-mounted" -v "$snapshot_dir:/srv/snapshot:ro"); then
  pass "container starts with the snapshot directory mounted read-only"
  snapshot_url="$mounted_url${base}hosted-snapshot.json"
  check "mounted snapshot is served under the base path" serves_text "$snapshot_url" "$marker"
  check "mounted snapshot is served with Cache-Control: no-store" has_no_store "$snapshot_url"
  check "snapshot mount is configured read-only" is_read_only "$run_id-mounted"
  check "the rest of the app is unaffected by the mount" is_status "$mounted_url$deep" 200
else
  fail "container starts with the snapshot directory mounted read-only"
fi

echo
if [[ $failures -eq 0 ]]; then
  echo "RESULT: PASSED"
  exit 0
fi
echo "RESULT: FAILED ($failures failed)"
exit 1
