#!/usr/bin/env bash
# Publica un dist/ YA COMPILADO al sitio de UN cliente, inyectando su config.
# No compila: correr scripts/build.sh <version> antes, una sola vez para todos.
#
#   app-config.js publicado  =  genx-base.js  +  config/clients/{slug}.js
#
# Usage: scripts/publish-client.sh <slug> <version> <bucket> <distribution-id> [--dry-run]
# Example: scripts/publish-client.sh mx-san-mungo v3 genx-viewer E1AB2CD3EF4GH
#
# Layout en S3:   s3://{bucket}/clients/{slug}/{version}/
# URL del cliente: https://{dominio-del-cliente}/{version}/viewer
#
# El slug NO aparece en la URL: la distribución CloudFront de cada cliente lleva
# `origin_path = /clients/{slug}`, así que el navegador ve la app en /{version}/.
# Eso es lo que permite que PUBLIC_URL sea igual para todos y el build se haga
# una sola vez. Sin esa distribución por cliente, este prefijo no es alcanzable.
#
# Contexto: GENX-MULTI-TENANT.md
set -euo pipefail

SLUG="${1:?Usage: publish-client.sh <slug> <version> <bucket> <distribution-id> [--dry-run]}"
VERSION="${2:?Usage: publish-client.sh <slug> <version> <bucket> <distribution-id> [--dry-run]}"
BUCKET="${3:?Usage: publish-client.sh <slug> <version> <bucket> <distribution-id> [--dry-run]}"
DISTRIBUTION_ID="${4:?Usage: publish-client.sh <slug> <version> <bucket> <distribution-id> [--dry-run]}"
DRY_RUN="${5:-}"

cd "$(dirname "$0")/.."

DIST_DIR="platform/app/dist"
CONFIG_DIR="platform/app/public/config"
CLIENT_CONFIG="${CONFIG_DIR}/clients/${SLUG}.js"
S3_PREFIX="s3://${BUCKET}/clients/${SLUG}/${VERSION}"

run() {
  if [[ "$DRY_RUN" == "--dry-run" ]]; then
    echo "    [dry-run] $*"
  else
    "$@"
  fi
}

# --- Verificaciones antes de tocar S3 ------------------------------------

[[ -f "${DIST_DIR}/index.html" ]] || {
  echo "ERROR: no hay build en ${DIST_DIR}. Correr: scripts/build.sh ${VERSION}" >&2
  exit 1
}

[[ -f "${CLIENT_CONFIG}" ]] || {
  echo "ERROR: no existe ${CLIENT_CONFIG}" >&2
  echo "       Crear el delta del cliente (ver ${CONFIG_DIR}/clients/README.md)." >&2
  exit 1
}

# El dist/ tiene que venir del base, no de un config legacy que ya trae un
# datastore horneado — publicar eso a un cliente le mostraría el de otro.
grep -q 'GENX_CONFIG_BASE' "${DIST_DIR}/app-config.js" || {
  echo "ERROR: ${DIST_DIR}/app-config.js no se construyó con config/genx-base.js." >&2
  echo "       Recompilar: scripts/build.sh ${VERSION}" >&2
  exit 1
}

# --- Composición del config del cliente -----------------------------------

COMPOSED="$(mktemp)"
trap 'rm -f "$COMPOSED"' EXIT

# El separador NO es cosmético. webpack pasa Terser también sobre los assets
# copiados, así que dist/app-config.js sale minificado a UNA sola línea y sin
# salto final. Un `cat` directo pegaría el último token del base con el primero
# del delta (`...,0)Object.assign(...`). El `;` en medio cierra la sentencia
# final del base pase lo que pase.
{
  cat "${DIST_DIR}/app-config.js"
  printf '\n;\n'
  cat "${CLIENT_CONFIG}"
} > "$COMPOSED"

# Ejecutar el resultado antes de subirlo: valida de una sola pasada que el delta
# no tenga error de sintaxis y que el datastore quede realmente asignado. Se
# pasa por stdin en vez de por ruta porque node es binario nativo de Windows y
# MSYS reescribe las rutas POSIX de los argumentos.
DATASTORE=$(node -e '
  global.window = {};
  global.document = {};
  let src = "";
  process.stdin.on("data", d => (src += d)).on("end", () => {
    try {
      eval(src);
    } catch (e) {
      console.error("config inválido: " + e.message);
      process.exit(1);
    }
    const ds = window.config?.dataSources?.[0]?.configuration?.healthlake?.datastoreID;
    if (!ds) {
      console.error("el delta no asignó datastoreID");
      process.exit(1);
    }
    process.stdout.write(ds);
  });
' < "$COMPOSED") || {
  echo "ERROR: ${CLIENT_CONFIG} no produce un config publicable (ver arriba)." >&2
  exit 1
}

echo "==> Publicando ${SLUG} / ${VERSION}"
echo "    datastore : ${DATASTORE}"
echo "    destino   : ${S3_PREFIX}/"
echo

# --- Subida ---------------------------------------------------------------

echo "==> Assets con hash (cache inmutable)"
run aws s3 sync "$DIST_DIR" "${S3_PREFIX}/" \
  --delete \
  --cache-control "public,max-age=31536000,immutable" \
  --exclude "index.html" \
  --exclude "app-config.js"

echo "==> index.html / app-config.js (no-cache — deciden qué carga)"
run aws s3 cp "${DIST_DIR}/index.html" "${S3_PREFIX}/index.html" --cache-control "no-cache"
run aws s3 cp "$COMPOSED" "${S3_PREFIX}/app-config.js" \
  --cache-control "no-cache" \
  --content-type "application/javascript"

# La invalidación usa la ruta que ve el navegador, NO la llave de S3: CloudFront
# quita `origin_path` antes de ir al origen, así que el prefijo clients/{slug}
# no aparece acá.
echo "==> Invalidando /${VERSION}/* en ${DISTRIBUTION_ID}"
run aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/${VERSION}/*"

echo
echo "==> Listo: https://<dominio-de-${SLUG}>/${VERSION}/viewer"
