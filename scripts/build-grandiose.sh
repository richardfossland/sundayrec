#!/usr/bin/env bash
#
# Build the vendored grandiose native module.
#
# Why this script exists:
#   grandiose's binding.gyp uses `library_dirs` whose values are passed to the
#   linker as `-L<path>` WITHOUT shell-escaping. When the absolute project
#   path contains spaces (this Mac is at .../Documents/Claude Code/sundayrec)
#   clang++ splits the `-L` flag and the build fails with
#       clang++: error: no such file or directory: 'Code/sundayrec/.../mac-a64'
#
# Symlinks don't help because node-gyp resolves them to the realpath before
# expanding gyp variables. The reliable fix is to build in a temporary path
# that contains no spaces, then copy the resulting native module + bundled
# libndi dylib back into vendor/grandiose/.
#
# CI runners (GitHub Actions) live at paths like /Users/runner/work/... with
# no spaces, so this dance is a no-op there — the early-out kicks in.
#
set -eo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SRC_DIR="$REPO_ROOT/vendor/grandiose"
OUT_NATIVE="$SRC_DIR/build/Release"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "[build-grandiose] vendor/grandiose missing — run 'git clone https://github.com/rse/grandiose vendor/grandiose'"
  exit 1
fi

# Fast path: if the project path contains no spaces, build in-place.
if [[ "$REPO_ROOT" != *" "* ]]; then
  echo "[build-grandiose] project path has no spaces — building in-place"
  cd "$SRC_DIR"
  npm install --no-audit --no-fund --loglevel=warn
  echo "[build-grandiose] done (in-place)"
  exit 0
fi

# Slow path: copy vendor/grandiose into /tmp, build there, copy artifacts back.
BUILD_DIR="${TMPDIR:-/tmp}/sundayrec-grandiose-build"
echo "[build-grandiose] path has spaces — building in $BUILD_DIR"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
# Copy sources only — skip node_modules, build/, ndi/ from any earlier attempt
rsync -a --delete \
  --exclude='node_modules/' \
  --exclude='build/' \
  --exclude='ndi/' \
  --exclude='.git/' \
  "$SRC_DIR/" "$BUILD_DIR/"

cd "$BUILD_DIR"
# `npm install` triggers the package's own install script: download NDI SDK,
# unpack into ./ndi/, then `node-gyp rebuild`. Since BUILD_DIR has no spaces
# the linker accepts the -L<path> directly.
npm install --no-audit --no-fund --loglevel=warn

# Copy the artifacts back into vendor/grandiose/.
rsync -a "$BUILD_DIR/ndi/"   "$SRC_DIR/ndi/"
rsync -a "$BUILD_DIR/build/" "$SRC_DIR/build/"
# Node modules are not required at runtime by grandiose itself (its deps are
# only used by ndi.js during install), so we deliberately do NOT copy them.

echo "[build-grandiose] artifacts copied to $SRC_DIR"
ls -la "$OUT_NATIVE"
