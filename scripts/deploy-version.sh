#!/usr/bin/env bash
# LEGACY — solo para republicar v1/v2, que llevan el datastore horneado en su
# config y no son multi-cliente. Para cualquier versión nueva usar:
#
#   scripts/build.sh <version>                                   # una vez
#   scripts/publish-client.sh <slug> <version> <bucket> <dist-id> # por cliente
#
# Este script compila y publica en un solo paso, lo que obliga a un build por
# cliente. Ver GENX-MULTI-TENANT.md.
#
# Build one version of the viewer and publish it to its S3 prefix, then
# invalidate that prefix's CloudFront cache. Infra (bucket, distribution)
# must already exist — see infra/viewer/.
#
# Usage: scripts/deploy-version.sh <version> <bucket> <distribution-id> [app-config]
# Example: scripts/deploy-version.sh v1 genx-viewer E1AB2CD3EF4GH
#          scripts/deploy-version.sh v2 genx-viewer E1AB2CD3EF4GH config/aws-healthimaging-v2.js
#
# app-config defaults to the v1 config (proxy reached directly at the Lambda
# Function URL). v2 onward pass their own variant — that's how a version picks
# which proxy endpoint gets baked into its bundle.
#
# Get bucket/distribution-id from `tofu output` in infra/viewer/.
set -euo pipefail

VERSION="${1:?Usage: deploy-version.sh <version e.g. v1> <bucket> <distribution-id> [app-config]}"
BUCKET="${2:?Usage: deploy-version.sh <version> <bucket> <distribution-id> [app-config]}"
DISTRIBUTION_ID="${3:?Usage: deploy-version.sh <version> <bucket> <distribution-id> [app-config]}"
APP_CONFIG="${4:-config/aws-healthimaging.js}"

cd "$(dirname "$0")/.."

echo "==> Building ${VERSION} (PUBLIC_URL=/${VERSION}/, APP_CONFIG=${APP_CONFIG})"
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
  "\$env:PUBLIC_URL='/${VERSION}/'; \$env:APP_CONFIG='${APP_CONFIG}'; yarn run build --skip-nx-cache"

DIST_DIR="platform/app/dist"

echo "==> Syncing hashed assets to s3://${BUCKET}/${VERSION}/ (immutable cache)"
aws s3 sync "$DIST_DIR" "s3://${BUCKET}/${VERSION}/" \
  --delete \
  --cache-control "public,max-age=31536000,immutable" \
  --exclude "index.html" \
  --exclude "app-config.js"

echo "==> Syncing index.html / app-config.js (no-cache — these decide what loads)"
aws s3 cp "$DIST_DIR/index.html" "s3://${BUCKET}/${VERSION}/index.html" --cache-control "no-cache"
aws s3 cp "$DIST_DIR/app-config.js" "s3://${BUCKET}/${VERSION}/app-config.js" --cache-control "no-cache"

echo "==> Invalidating CloudFront /${VERSION}/*"
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/${VERSION}/*"

echo "==> Done: https://<cloudfront-domain>/${VERSION}/viewer"
