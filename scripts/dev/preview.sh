#!/usr/bin/env bash
# Local preview of Drivo with live demo data.
#   1. Starts local Supabase (Docker) and resets it to the demo seed.
#   2. Builds and starts the admin web app on http://localhost:3000.
#   3. Runs the driver simulator, so vehicles move on the live map.
# Sign in as admin@nadera.test with the password DrivoDemo2026.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
npx supabase start -x studio,mailpit,imgproxy,edge-runtime,logflare,vector,supavisor,postgres-meta
npx supabase db reset
eval "$(npx supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
cat > web/.env.local <<ENV
NEXT_PUBLIC_SUPABASE_URL=$API_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
BILLZILLA_WEBHOOK_SECRET=local-billzilla-master-secret
KAIWORKFORCE_WEBHOOK_SECRET=local-kaiworkforce-master-secret
CRON_SECRET=local-cron-secret
NEXT_TELEMETRY_DISABLED=1
ENV
(cd web && npm install && npx next build)
(cd web && npx next start -p 3000) &
WEB=$!
trap 'kill $WEB 2>/dev/null' EXIT
node scripts/dev/simulate-drivers.mjs
