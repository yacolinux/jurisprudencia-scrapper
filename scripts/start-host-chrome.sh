#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
CHROME_BIN="${CHROME_BIN:-$(command -v google-chrome || command -v chromium || true)}"
CDP_PORT="${JURIS_CDP_PORT:-9222}"
PROFILE_DIR="${JURIS_CHROME_PROFILE:-/tmp/mvp-jurisprudencia-chrome-profile}"

if [[ -z "$CHROME_BIN" ]]; then
  echo "No se encontró google-chrome ni chromium en el host." >&2
  exit 1
fi
if [[ -z "${DISPLAY:-}" ]]; then
  echo "DISPLAY no está configurado; este modo requiere una sesión gráfica del host." >&2
  exit 1
fi
if curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  echo "Chrome CDP ya está disponible en http://127.0.0.1:${CDP_PORT}" >&2
  exit 0
fi

mkdir -p "$PROFILE_DIR"
CHROME_ARGS=(
  --user-data-dir="$PROFILE_DIR"
  --remote-debugging-address=127.0.0.1
  --remote-debugging-port="$CDP_PORT"
  --remote-allow-origins=*
  --no-first-run
  --no-default-browser-check
  --disable-dev-shm-usage
  about:blank
)

if command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  RUNNER=(systemd-run --user --unit=mvp-jurisprudencia-chrome --collect --property=Restart=no)
  [[ -n "${DISPLAY:-}" ]] && RUNNER+=("--setenv=DISPLAY=${DISPLAY}")
  [[ -n "${XAUTHORITY:-}" ]] && RUNNER+=("--setenv=XAUTHORITY=${XAUTHORITY}")
  "${RUNNER[@]}" "$CHROME_BIN" "${CHROME_ARGS[@]}" >/tmp/mvp-jurisprudencia-chrome.log 2>&1
else
  setsid nohup "$CHROME_BIN" "${CHROME_ARGS[@]}" >/tmp/mvp-jurisprudencia-chrome.log 2>&1 < /dev/null &
fi

for _ in {1..50}; do
  if curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    echo "Chrome CDP disponible en http://127.0.0.1:${CDP_PORT}"
    exit 0
  fi
  sleep 0.2
done

echo "Chrome no abrió el endpoint CDP. Revisá /tmp/mvp-jurisprudencia-chrome.log" >&2
exit 1
