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
# Mac universal binary:
#   On macOS we build grandiose.node for BOTH arm64 and x86_64 then `lipo`
#   them into one fat .node. Without this, .dmg installs on the "other"
#   architecture would fail to load grandiose with an arch-mismatch error
#   ("incompatible architecture (have arm64, need x86_64)" or vice versa).
#   libndi.dylib that ships from NDI SDK is already fat (arm64 + x86_64).
#
set -eo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SRC_DIR="$REPO_ROOT/vendor/grandiose"
OUT_NATIVE="$SRC_DIR/build/Release"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "[build-grandiose] vendor/grandiose missing — run 'git clone https://github.com/rse/grandiose vendor/grandiose'"
  exit 1
fi

# Pick the working directory: in-place when path has no spaces, otherwise
# stage into /tmp where the linker accepts unquoted -L flags.
if [[ "$REPO_ROOT" != *" "* ]]; then
  echo "[build-grandiose] project path has no spaces — building in-place"
  WORK_DIR="$SRC_DIR"
  IS_INPLACE=1
else
  WORK_DIR="${TMPDIR:-/tmp}/sundayrec-grandiose-build"
  IS_INPLACE=0
  echo "[build-grandiose] path has spaces — staging in $WORK_DIR"
  rm -rf "$WORK_DIR"
  mkdir -p "$WORK_DIR"
  rsync -a --delete \
    --exclude='node_modules/' \
    --exclude='build/' \
    --exclude='ndi/' \
    --exclude='.git/' \
    "$SRC_DIR/" "$WORK_DIR/"
fi

cd "$WORK_DIR"

# `npm install --ignore-scripts` then run the package's install script in
# pieces so we control the arch on the build step. ndi.js downloads the
# NDI SDK distribution (universal on Mac); node-gyp does the native build.
npm install --ignore-scripts --no-audit --no-fund --loglevel=warn
node ndi.js

if [[ "$(uname)" == "Darwin" ]]; then
  echo "[build-grandiose] mac — building universal binary (arm64 + x86_64)"

  # ndi.js drops libndi.dylib only into ndi/lib/mac-a64/, but the dylib is
  # already a universal fat binary (arm64 + x86_64). binding.gyp expects to
  # find it at ndi/lib/mac-x64/ when target_arch=x64. Mirror it across so
  # gyp resolves both arch paths.
  if [[ -f ndi/lib/mac-a64/libndi.dylib && ! -f ndi/lib/mac-x64/libndi.dylib ]]; then
    mkdir -p ndi/lib/mac-x64
    cp ndi/lib/mac-a64/libndi.dylib ndi/lib/mac-x64/libndi.dylib
  fi

  # Build arm64 — node-gyp picks up the target_arch from npm_config_arch.
  # Clean is mandatory between arches; otherwise gyp keeps the last cache.
  echo "[build-grandiose]   → arm64"
  npx node-gyp clean
  npm_config_arch=arm64 npx node-gyp configure
  npm_config_arch=arm64 npx node-gyp build
  cp build/Release/grandiose.node "/tmp/grandiose.node.arm64"

  echo "[build-grandiose]   → x86_64"
  npx node-gyp clean
  npm_config_arch=x64 npx node-gyp configure
  npm_config_arch=x64 npx node-gyp build
  cp build/Release/grandiose.node "/tmp/grandiose.node.x64"

  echo "[build-grandiose]   → lipo merge → universal"
  # node-gyp's "build" already copied libndi.dylib (universal) into
  # build/Release. We just need to replace the per-arch .node with a fat one.
  lipo -create "/tmp/grandiose.node.arm64" "/tmp/grandiose.node.x64" \
       -output build/Release/grandiose.node
  rm -f "/tmp/grandiose.node.arm64" "/tmp/grandiose.node.x64"

  echo "[build-grandiose]   verify universal:"
  lipo -info build/Release/grandiose.node
else
  # Linux / Windows — build current arch only. electron-builder runs this
  # script on the matching runner so we don't need cross-compile here.
  echo "[build-grandiose] non-mac — building current arch"
  npx node-gyp rebuild
fi

if [[ "$IS_INPLACE" -eq 0 ]]; then
  # Copy artifacts back from /tmp to the repo path.
  rsync -a "$WORK_DIR/ndi/"   "$SRC_DIR/ndi/"
  rsync -a "$WORK_DIR/build/" "$SRC_DIR/build/"
fi

echo "[build-grandiose] artifacts in $OUT_NATIVE:"
ls -la "$OUT_NATIVE"
