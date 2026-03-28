#!/bin/sh
set -e

# Prefer ADMIN_API_KEY (full access including settings/memory-admin endpoints).
# Fall back to API_KEY (regular user access only).
# API_KEY may be a comma-separated list (inherited from AUTH_API_KEYS) — extract the first one.
if [ -n "${ADMIN_API_KEY:-}" ]; then
  SINGLE_KEY=$(echo "${ADMIN_API_KEY}" | tr -d '[:space:]')
else
  SINGLE_KEY=$(echo "${API_KEY:-}" | cut -d',' -f1 | tr -d '[:space:]')
fi

# Replace __API_KEY__ placeholder in nginx config with the resolved key.
# If neither key is set, the header is sent as an empty string (backend will reject if auth is on).
sed -i "s|__API_KEY__|${SINGLE_KEY}|g" /etc/nginx/conf.d/default.conf

exec "$@"
