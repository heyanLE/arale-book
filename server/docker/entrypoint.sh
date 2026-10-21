#!/bin/sh
set -eu
umask 077
if [ ! -d "$ARALE_SERVER_LIBRARY" ] || [ ! -r "$ARALE_SERVER_LIBRARY" ]; then
  echo 'Comic library is not readable; check the read-only library mount.' >&2
  exit 1
fi
if [ ! -w "$ARALE_SERVER_DATA" ]; then
  echo 'Data directory is not writable by the configured container UID/GID.' >&2
  exit 1
fi
# The probe runs once on startup; health checks never repeatedly load neural nets.
python3 /opt/arale/ocr/verify-runtime.py --probe
exec node /app/main.mjs "$@"
