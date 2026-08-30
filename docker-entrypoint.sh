#!/bin/sh
set -eu

# El bind mount puede haber sido creado por Docker como root. Ajustarlo aquí
# permite conservar los PDFs en el host y mantener la app/Chromium sin root.
if [ "${DATA_READ_ONLY:-0}" != "1" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  chown -R app:app "${DATA_DIR:-/data}"
fi

if [ "$#" -eq 0 ]; then
  set -- node /app/src/web-server.mjs
fi

exec su app -s /bin/sh -c 'exec "$0" "$@"' -- "$@"
