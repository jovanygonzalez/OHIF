#!/usr/bin/env bash
# Compila el visor UNA sola vez. El resultado en platform/app/dist/ es
# client-agnostic: no contiene el datastore de nadie.
#
# El único archivo por cliente (app-config.js) lo inyecta publish-client.sh al
# publicar, porque webpack copia el config tal cual en vez de bundlearlo
# (.webpack/webpack.pwa.js). Por eso N clientes NO cuestan N builds.
#
# Usage: scripts/build.sh <version> [base-config]
# Example: scripts/build.sh v3
#
# Después:
#   scripts/publish-client.sh mx-san-mungo v3 genx-viewer <distribution-id>
#
# Contexto: GENX-MULTI-TENANT.md
set -euo pipefail

VERSION="${1:?Usage: build.sh <version e.g. v3> [base-config]}"
BASE_CONFIG="${2:-config/genx-base.js}"

cd "$(dirname "$0")/.."

if [[ ! -f "platform/app/public/${BASE_CONFIG}" ]]; then
  echo "ERROR: no existe platform/app/public/${BASE_CONFIG}" >&2
  exit 1
fi

echo "==> Building ${VERSION} (PUBLIC_URL=/${VERSION}/, APP_CONFIG=${BASE_CONFIG})"
# Two Windows-specific gotchas, both confirmed by inspecting the actual built
# HTML — don't "simplify" this back to a plain `yarn run build` call:
#
# 1. Git Bash's MSYS layer silently rewrites leading-slash env var values
#    somewhere in the yarn -> lerna -> webpack spawn chain: PUBLIC_URL=/v1/
#    becomes C:/Program Files/Git/v1/, and Webpack bakes that broken path
#    into every asset URL. MSYS_NO_PATHCONV=1 does NOT fix this for the full
#    chain (only for a process bash spawns directly) — the only reliable fix
#    found was running the build via powershell.exe, which has no MSYS path
#    conversion at all.
# 2. Nx's build cache does not key on PUBLIC_URL, so a second build with a
#    different PUBLIC_URL silently replays the previous version's cached
#    dist/ instead of rebuilding — fatal for multi-version deploys (v2 would
#    ship v1's bytes). --skip-nx-cache forces a real rebuild every time.
powershell.exe -NoProfile -Command \
  "\$env:PUBLIC_URL='/${VERSION}/'; \$env:APP_CONFIG='${BASE_CONFIG}'; yarn run build --skip-nx-cache"

echo
echo "==> Listo: platform/app/dist/ (sin datastore — falta el delta de cliente)"
echo "    Publicar con: scripts/publish-client.sh <slug> ${VERSION} <bucket> <distribution-id>"
