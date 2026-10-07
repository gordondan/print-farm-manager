#!/bin/sh
# Install the shared Labels and Batch Slice Orca worker as a launchd agent.
set -eu

LABEL=com.dagordons.garden-slicer-worker
OLD_LABEL=com.dagordons.garden-label-worker
HERE=$(cd "$(dirname "$0")" && pwd)
WORKER=$(cd "$HERE/../../slicer" && pwd)/worker.py
PY=$(command -v python3)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/garden-slicer-worker.log"

if [ -z "${PRINTGARDEN_WORKER_TOKEN:-}" ]; then
  echo "Set PRINTGARDEN_WORKER_TOKEN to the same secret configured on the Print Garden server." >&2
  exit 1
fi
if [ -z "${ORCA_PRESET_ROOTS:-}" ]; then
  echo "Set ORCA_PRESET_ROOTS to one or more OrcaSlicer preset directories (colon-separated)." >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g'
}

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$(xml_escape "$PY")</string><string>$(xml_escape "$WORKER")</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$(dirname "$PY"):/usr/bin:/bin:/usr/sbin:/sbin")</string>
    <key>PYTHONUNBUFFERED</key><string>1</string>
    <key>PRINTGARDEN_URL</key><string>$(xml_escape "${PRINTGARDEN_URL:-http://localhost:3000}")</string>
    <key>PRINTGARDEN_WORKER_TOKEN</key><string>$(xml_escape "$PRINTGARDEN_WORKER_TOKEN")</string>
    <key>PRINTGARDEN_SOURCE_ROOTS</key><string>$(xml_escape "${PRINTGARDEN_SOURCE_ROOTS:-}")</string>
    <key>ORCA_PRESET_ROOTS</key><string>$(xml_escape "$ORCA_PRESET_ROOTS")</string>
    <key>ORCA_PATH</key><string>$(xml_escape "${ORCA_PATH:-}")</string>
    <key>SLICER_WORKER_POLL</key><string>$(xml_escape "${SLICER_WORKER_POLL:-4}")</string>
    <key>CF_ACCESS_CLIENT_ID</key><string>$(xml_escape "${CF_ACCESS_CLIENT_ID:-}")</string>
    <key>CF_ACCESS_CLIENT_SECRET</key><string>$(xml_escape "${CF_ACCESS_CLIENT_SECRET:-}")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG")</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$OLD_LABEL" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL -> $WORKER (log: $LOG)"
