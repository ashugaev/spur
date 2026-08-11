#!/usr/bin/env bash
set -euo pipefail

rm -rf v2/web
mkdir -p v2/web
# In a pnpm monorepo, Next emits standalone/<workspace-path>/server.js.
# Flatten so v2/web/server.js sits next to node_modules and .next.
cp -R packages/web/.next/standalone/packages/web/. v2/web/
mkdir -p v2/web/.next
cp -R packages/web/.next/static v2/web/.next/static
if [ -d packages/web/public ]; then
  cp -R packages/web/public v2/web/public
fi
cp -R packages/web/dist-server v2/web/dist-server
# pnpm's standalone node_modules is a symlink farm into the pnpm
# store; npm pack silently drops symlinks. Materialize real deps.
rm -rf v2/web/node_modules
npm install --prefix v2/web --omit=dev --ignore-scripts --no-audit --no-fund
npm run install --prefix v2/web/node_modules/node-pty
# node-pty's published `files` list ships prebuilds/ but not build/,
# so the freshly-compiled binary would be dropped by `npm pack` and
# the end host would need a C/C++ toolchain to rebuild it. Move the
# CI-built binary into the prebuilds layout node-pty already checks
# (lib/utils.js loadNativeModule: build/Release, build/Debug, then
# prebuilds/<platform>-<arch>) so it survives packaging.
# spawn-helper is a macOS-only binding.gyp target (pty.cc guards its
# use with `#if defined(__APPLE__)`; on Linux it calls forkpty()
# directly) — a Linux build/Release/ never contains it, so only
# pty.node is copied here.
pty_dir="v2/web/node_modules/node-pty"
arch="$(node -p process.arch)"
prebuild_dir="$pty_dir/prebuilds/linux-$arch"
mkdir -p "$prebuild_dir"
cp "$pty_dir/build/Release/pty.node" "$prebuild_dir/pty.node"
rm -rf "$pty_dir/build"
echo "note: only linux-$arch prebuild is bundled (self-hosted runner is single-arch); linux-arm64 is NOT bundled"
# Presence in the tarball is not loadability: node-pty's import is
# try/caught in direct-terminal-ws.ts, so a wrong-arch/ABI/libc binary
# would still boot the web UI and pass the /ws 101 check while the
# terminal silently fails on hosts. build/ is gone, so this require
# exercises the moved prebuild — fail the release if it can't load.
(cd v2/web && node -e "require('node-pty')") \
  || { echo "bundled node-pty prebuild failed to load"; exit 1; }
