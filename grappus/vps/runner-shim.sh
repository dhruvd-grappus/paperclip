#!/bin/bash
# paperclip_runner (native runtime) repair for the managed npm install. Run as paperclip after every
# paperclipai upgrade. Three defects in the npm build of 2026.916.1:
#  1. @paperclipai/paperclip-runner is private (never published) but the server imports the bare
#     specifier; the code is vendored under server/dist/vendor/paperclip-runner. -> package shim.
#  2. The ACPX Claude driver pins @anthropic-ai/claude-agent-sdk 0.3.263 (pnpm override upstream);
#     npm resolved the declared 0.3.257. -> pin at root, drop the nested copy under claude-agent-acp.
#  3. npm install prunes the shim, so order matters: npm first, shim last. Restart paperclip after.
set -euo pipefail
INSTALL=$(readlink -f /home/paperclip/.paperclip/cli/current)  # the install that runs, not the newest dir
cd "$INSTALL"
R="$INSTALL/node_modules"
SDK_VER=$(node -e "const s=require('fs').readFileSync('$R/@paperclipai/server/dist/vendor/paperclip-runner/drivers/acpx/installation-integrity.js','utf8');console.log(s.match(/runtimePackageName: \"@anthropic-ai\/claude-agent-sdk\",\s*runtimePackageVersion: \"([^\"]+)\"/)[1])")
echo "pinned claude-agent-sdk: $SDK_VER"
if [ "$(jq -r .version $R/@anthropic-ai/claude-agent-sdk/package.json)" != "$SDK_VER" ]; then
  cp -n package.json package.json.pre-runner-shim || true
  npm install --no-audit --no-fund --save-exact "@anthropic-ai/claude-agent-sdk@$SDK_VER" 2>&1 | tail -2
fi
NESTED="$R/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai"
if [ -d "$NESTED" ]; then mv "$NESTED" "/home/paperclip/.nested-anthropic-sdk-$(date +%s).bak"; echo "removed nested sdk copy"; fi
# 2b. zod must be the pinned version as resolved from claude-agent-acp; root zod (server) stays as is.
ZOD_VER=$(node -e "const s=require('fs').readFileSync('$R/@paperclipai/server/dist/vendor/paperclip-runner/drivers/acpx/installation-integrity.js','utf8');console.log(s.match(/packageName: \"zod\",\s*packageVersion: \"([^\"]+)\"/)[1])")
ZN="$R/@agentclientprotocol/claude-agent-acp/node_modules/zod"
if [ "$(jq -r .version $ZN/package.json 2>/dev/null)" != "$ZOD_VER" ]; then
  rm -rf "$ZN"; mkdir -p "$ZN"; T=$(mktemp -d); (cd "$T" && npm pack "zod@$ZOD_VER" --silent >/dev/null && tar xzf zod-*.tgz --strip-components=1 -C "$ZN"); rm -rf "$T"; echo "nested zod $ZOD_VER installed"
fi
V="$R/@paperclipai/server/dist/vendor/paperclip-runner"
[ -f "$V/index.js" ] || { echo "vendor runner missing"; exit 1; }
# The ACPX transport derives the sidecar path from import.meta.url and requires a <pkg>/dist/cli layout
# (acpxProviderPackageAuthority). The server ALSO imports the vendor tree by relative path, so the only
# layout that satisfies both is: real files at <shim>/dist, and server/dist/vendor/paperclip-runner as a
# symlink to it. Node resolves symlinks to realpath, so both import styles load one module instance.
P="$R/@paperclipai/paperclip-runner"; mkdir -p "$P"
if [ ! -L "$V" ]; then
  rm -rf "$P/dist"; mv "$V" "$P/dist"; ln -s "$P/dist" "$V"; echo "moved vendor runner to $P/dist, symlinked vendor -> shim"
fi
[ -f "$P/dist/live/index.js" ] || { echo "shim dist broken"; exit 1; }
# The vendor tree used to resolve `acpx` from server/node_modules; from the shim it must be reachable too.
mkdir -p "$P/node_modules"; ln -sfn "$R/@paperclipai/server/node_modules/acpx" "$P/node_modules/acpx"
(cd "$P/dist" && node --input-type=module -e "await import('acpx/runtime'); console.log('acpx resolvable from shim')")
# runnerd refuses "qualified ACPX must not be group- or world-writable": npm leaves dirs 775.
chmod -R go-w "$R" 2>/dev/null || true; chmod go-w "$INSTALL" /home/paperclip/.paperclip/cli/installs/npm /home/paperclip/.paperclip/cli/installs /home/paperclip/.paperclip/cli 2>/dev/null || true
echo "perms tightened (go-w) on $R"
cat > "$P/package.json" <<'JSON'
{ "name": "@paperclipai/paperclip-runner", "version": "0.0.0-vendored", "type": "module",
  "bin": { "paperclip-runner-acpx-sidecar": "./dist/cli/acpx-runtime-sidecar.js",
           "paperclip-runner-codex-proxy": "./dist/cli/codex-app-server-unix-proxy.js",
           "paperclip-runner-opencode-proxy": "./dist/cli/opencode-app-server-proxy.js" },
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./testing": { "import": "./dist/testing.js" }, "./evals": { "import": "./dist/evals/index.js" },
    "./live": { "import": "./dist/live/index.js" }, "./devtools": { "import": "./dist/devtools/index.js" },
    "./browser": { "import": "./dist/browser/index.js" }, "./react": { "import": "./dist/react/index.js" },
    "./standalone": { "import": "./dist/standalone/index.js" }, "./package.json": "./package.json" } }
JSON
node --input-type=module -e "await import('@paperclipai/paperclip-runner/live'); console.log('shim ok')"
# 4. npm install also restores the unpatched ACP bridge, which then emits no
#    thinking text; re-apply the reasoning patch here so an upgrade cannot
#    silently turn reasoning off again.
if [ -x /home/paperclip/acpx-thinking-patch.sh ]; then
  /home/paperclip/acpx-thinking-patch.sh || echo "WARN: acpx-thinking-patch failed"
fi
echo "sdk root: $(jq -r .version $R/@anthropic-ai/claude-agent-sdk/package.json)  linux-x64: $(jq -r .version $R/@anthropic-ai/claude-agent-sdk-linux-x64/package.json 2>/dev/null)"
echo "now: systemctl restart paperclip (as root) when live-runs is empty"
