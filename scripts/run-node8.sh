#!/usr/bin/env bash
# Runs a JavaScript file under Node 8.16.2 (the head unit's runtime), or with --check only
# syntax-checks it (`node --check`).
#
#   scripts/run-node8.sh [--check] <file.js>
#
# The runtime is chosen in this order:
#   1. the Docker image node:8.16.2, when the Docker daemon answers (`docker info`);
#   2. the binary named by $NODE8_BIN, when `"$NODE8_BIN" -v` prints v8.16.2;
#   3. `npx --yes -p node@8.16.2 node`, only on x86_64 (Node 8 has no arm64 build);
#   4. with NODE8_STATIC_FALLBACK=1: a static ES2017 syntax check only
#      (scripts/node8-static-check.mjs, ESLint's parser, no rules). It prints a warning and exits 0
#      only if the file parses. In this mode --check and a run behave the same.
#   5. otherwise: says what is missing and how to fix it, and exits with status 3.
set -euo pipefail

readonly NODE8_VERSION="v8.16.2"
readonly NODE8_IMAGE="node:8.16.2"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

usage() {
  echo "usage: scripts/run-node8.sh [--check] <file.js>" >&2
  exit 2
}

check_flag=""
if [ "${1:-}" = "--check" ]; then
  check_flag="--check"
  shift
fi
[ "$#" -eq 1 ] || usage
file="$1"
if [ ! -f "$file" ]; then
  echo "run-node8: no such file: $file" >&2
  exit 2
fi
file_abs="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"

# 1. Docker. The repository (and the file's directory, if it lies outside) is mounted read-only
#    at the same path; the container has no network.
docker_state="not installed"
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    file_dir="$(dirname "$file_abs")"
    case "$file_dir/" in
      "$repo_root"/*) extra_mount="" ;;
      *) extra_mount="$file_dir" ;;
    esac
    if [ -n "$extra_mount" ]; then
      exec docker run --rm --network none \
        -v "$repo_root:$repo_root:ro" -v "$extra_mount:$extra_mount:ro" \
        -w "$repo_root" "$NODE8_IMAGE" node $check_flag "$file_abs"
    fi
    exec docker run --rm --network none \
      -v "$repo_root:$repo_root:ro" \
      -w "$repo_root" "$NODE8_IMAGE" node $check_flag "$file_abs"
  fi
  docker_state="installed, but the daemon does not answer (docker info failed)"
fi

# 2. An explicit Node 8.16.2 binary.
node8_bin_state="not set"
if [ -n "${NODE8_BIN:-}" ]; then
  reported="$("$NODE8_BIN" -v 2>/dev/null || true)"
  if [ "$reported" = "$NODE8_VERSION" ]; then
    exec "$NODE8_BIN" $check_flag "$file_abs"
  fi
  node8_bin_state="set to $NODE8_BIN, which reports '${reported:-nothing}' instead of $NODE8_VERSION"
fi

# 3. The node@8.16.2 npm package; it only has x86_64 builds.
arch="$(uname -m)"
if [ "$arch" = "x86_64" ] && command -v npx >/dev/null 2>&1; then
  exec npx --yes -p node@8.16.2 node $check_flag "$file_abs"
fi

# 4. Opt-in static syntax check.
if [ "${NODE8_STATIC_FALLBACK:-}" = "1" ]; then
  echo "WARNING: Node 8.16.2 runtime not available - static ES2017 syntax check only" >&2
  exec node "$script_dir/node8-static-check.mjs" "$file_abs"
fi

# 5. Nothing usable.
cat >&2 <<EOF
run-node8: no Node 8.16.2 runtime is available to run $file
  - Docker: $docker_state
  - NODE8_BIN: $node8_bin_state
  - npx node@8.16.2: needs an x86_64 machine, this one is $arch
Fix one of these:
  - start Docker (for example Docker Desktop) so the $NODE8_IMAGE image can run;
  - or set NODE8_BIN to a Node $NODE8_VERSION binary;
  - or set NODE8_STATIC_FALLBACK=1 for a static ES2017 syntax check only (not a runtime test).
EOF
exit 3
