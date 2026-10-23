#!/bin/sh
# Tower Tracker entrypoint: make /data owned by PUID:PGID (Unraid default 99:100), then drop root
# and exec the app so it receives SIGTERM directly.
set -eu

PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-0002}"
DATA_DIR="${DATA_DIR:-/data}"
APP="/app/server/dist/index.js"

case "$PUID" in '' | *[!0-9]*) echo "PUID must be a number (got '$PUID')" >&2; exit 1 ;; esac
case "$PGID" in '' | *[!0-9]*) echo "PGID must be a number (got '$PGID')" >&2; exit 1 ;; esac
case "$UMASK" in '' | *[!0-7]*) echo "UMASK must be octal, e.g. 0002 (got '$UMASK')" >&2; exit 1 ;; esac
umask "$UMASK"
# Normalise to plain decimal so "00" can't sneak past the root check below.
# (expr exits 1 when the result is 0, hence "|| true" under set -e.)
PUID=$(expr "$PUID" + 0 || true)
PGID=$(expr "$PGID" + 0 || true)

if [ "$(id -u)" = "0" ]; then
  if [ "$PUID" = "0" ] && [ "${ALLOW_ROOT:-}" != "1" ]; then
    echo "Refusing to run the app as root (PUID=0). Set ALLOW_ROOT=1 to override." >&2
    exit 1
  fi
  mkdir -p "$DATA_DIR/attachments" "$DATA_DIR/backups" "$DATA_DIR/tmp"
  # Only touch files whose ownership is wrong, so this stays cheap with many attachments.
  find "$DATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} +
  if ! setpriv --reuid="$PUID" --regid="$PGID" --clear-groups test -w "$DATA_DIR"; then
    echo "$DATA_DIR is not writable by $PUID:$PGID. Check the volume mapping and its permissions." >&2
    exit 1
  fi
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all --no-new-privs node "$APP"
fi

# Already started as a non-root user (e.g. `docker run --user 99:100`): just run.
mkdir -p "$DATA_DIR/attachments" "$DATA_DIR/backups" "$DATA_DIR/tmp"
exec node "$APP"
