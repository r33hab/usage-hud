#!/usr/bin/env bash
# Builds, installs to ~/Applications, and registers a login item so the panel
# comes back after a restart. Run this instead of build.sh once you are settled;
# build.sh alone only updates the copy under ./build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.r33hab.usage-hud"
DEST="$HOME/Applications/UsageHUD.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

if [ "${1:-}" = "--uninstall" ]; then
  echo "› removing login item"
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "› stopping and removing $DEST"
  pkill -x UsageHUD 2>/dev/null || true
  rm -rf "$DEST"
  echo
  echo "uninstalled. ~/.config/usage-hud and ~/.cache/usage-hud were left alone."
  exit 0
fi

"$ROOT/build.sh"

echo "› installing to $DEST"
mkdir -p "$HOME/Applications"
pkill -x UsageHUD 2>/dev/null || true
sleep 1
rm -rf "$DEST"
cp -R "$ROOT/build/UsageHUD.app" "$DEST"

echo "› writing $PLIST"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$DEST/Contents/MacOS/UsageHUD</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
PLIST_BODY
plutil -lint "$PLIST" >/dev/null

echo "› registering with launchd"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null \
  || launchctl load -w "$PLIST"

echo
if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
  echo "registered: launches at login, and started now"
else
  echo "plist written, but launchd did not report the job - check: launchctl print gui/$UID_NUM/$LABEL"
fi
echo "app:   $DEST"
echo "plist: $PLIST"
echo
echo "Toggle it later from the panel's right-click menu (Launch at Login), or:"
echo "  ./install.sh --uninstall"
