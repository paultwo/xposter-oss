#!/bin/sh
set -eu
if [ ! -f .dev.vars ]; then
  printf '%s\n' \
    'X_CLIENT_ID=test-client-id' \
    'X_CLIENT_SECRET=test-client-secret' \
    'TOKEN_ENC_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=' \
    'CSRF_SECRET=test-csrf-secret' \
    'INTAKE_TOKEN=test-intake-token' > .dev.vars
fi
port="${PORT:-8787}"
persist="${PERSIST:-.wrangler/proof}"
rm -rf "$persist"
npx wrangler d1 migrations apply x-poster --local --config wrangler.proof.jsonc --persist-to "$persist"
exec npx wrangler dev --config wrangler.proof.jsonc --port "$port" --ip 127.0.0.1 --persist-to "$persist" --var "PUBLIC_ORIGIN:http://127.0.0.1:${port}" "$@"
