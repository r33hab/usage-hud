#!/usr/bin/env bash
# Builds UsageHUD.app into ./build. No dependencies beyond the Xcode Command
# Line Tools (swiftc) and a node binary on this machine.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/build/UsageHUD.app"
MACOS="$APP/Contents/MacOS"
RES="$APP/Contents/Resources"

command -v swiftc >/dev/null || { echo "swiftc not found - install Xcode Command Line Tools"; exit 1; }
NODE="${USAGE_HUD_NODE:-$(command -v node || true)}"
[ -x "$NODE" ] || { echo "node not found - install node or set USAGE_HUD_NODE"; exit 1; }

echo "› cleaning"
rm -rf "$APP"
mkdir -p "$MACOS" "$RES"

echo "› compiling main.swift"
swiftc -O -swift-version 5 \
  -target "$(uname -m)-apple-macos13.0" \
  -framework AppKit -framework WebKit -framework Carbon \
  -o "$MACOS/UsageHUD" \
  "$ROOT/src/main.swift"

echo "› bundling resources"
cp "$ROOT/ui/hud.html" "$RES/hud.html"
cp "$ROOT/collect.mjs" "$RES/collect.mjs"
printf '%s' "$NODE" > "$RES/node-path.txt"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>UsageHUD</string>
  <key>CFBundleDisplayName</key><string>usage-hud</string>
  <key>CFBundleIdentifier</key><string>com.r33hab.usage-hud</string>
  <key>CFBundleExecutable</key><string>UsageHUD</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
</dict>
</plist>
PLIST

printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "› signing (ad-hoc)"
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "  (unsigned - still runs locally)"

echo
echo "built: $APP"
echo "run:   open '$APP'"
echo "node:  $NODE"
