#!/bin/sh
set -eu

tunnel_name=${1:?Usage: start-tunnel.sh TUNNEL_NAME [--setup-only|--force-recreate]}
mode=${2:-}
case "$mode" in
  ''|--setup-only|--force-recreate) ;;
  *) printf 'Unknown tunnel option: %s\n' "$mode" >&2; exit 2 ;;
esac
config=deploy/cloudflared.yml
credentials=deploy/cloudflared-credentials.json

if [ ! -e "$config" ] && [ ! -L "$config" ] && [ -f deploy/cloudflared.example.yml ]; then
  (umask 077; set -C; cat deploy/cloudflared.example.yml > "$config")
fi

start_tunnel() {
  docker compose --profile tunnel up --no-deps --wait --wait-timeout 90 "$@" cloudflared
}

is_uuid() {
  printf '%s\n' "$1" | grep -Eiq '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
}

stage_credentials() {
  umask 077
  tmp=$(mktemp -d deploy/.cloudflared-credentials.XXXXXX)
  trap 'rm -f -- "$tmp/credentials.json" "$tmp/cloudflared.yml"; rmdir -- "$tmp"' EXIT
}

if [ ! -r "$config" ]; then
  printf 'Cannot read %s. See the Cloudflare setup in README.md.\n' "$config" >&2
  exit 1
fi
if [ -d "$credentials" ]; then
  printf 'Expected a credentials file at %s.\n' "$credentials" >&2
  exit 1
fi

configured_id=$(awk '/^tunnel:[[:space:]]/ { gsub(/["\047]/, "", $2); print $2 == "REPLACE_WITH_TUNNEL_UUID" ? $2 : tolower($2); exit }' "$config")
if [ "$mode" = --setup-only ]; then
  local_credentials=$HOME/.cloudflared/$configured_id.json
  if [ ! -e "$credentials" ] && [ ! -L "$credentials" ] && is_uuid "$configured_id" && [ -r "$local_credentials" ]; then
    stage_credentials
    install -m 600 "$local_credentials" "$tmp/credentials.json"
    if ! ln "$tmp/credentials.json" "$credentials" && [ ! -f "$credentials" ]; then exit 1; fi
  fi
  exit 0
fi

if [ -f "$credentials" ] && [ -s "$credentials" ] && [ "$configured_id" != REPLACE_WITH_TUNNEL_UUID ]; then
  if start_tunnel ${mode:+"$mode"}; then
    exit 0
  fi
  if ! docker compose --profile tunnel logs --since 3m --tail 60 cloudflared 2>&1 |
    grep -Fq 'Unauthorized: Invalid tunnel secret'; then
    printf 'Cloudflare tunnel failed to start. See make logs.\n' >&2
    exit 1
  fi
fi

printf 'Fetching current Cloudflare credentials for %s.\n' "$tunnel_name"
if ! tunnels=$(cloudflared tunnel list --name "$tunnel_name"); then
  printf 'Cannot look up %s. Check the Cloudflare CLI login on this host.\n' "$tunnel_name" >&2
  exit 1
fi
tunnel_id=$(printf '%s\n' "$tunnels" | awk -v name="$tunnel_name" '$2 == name { print tolower($1); exit }')
if ! is_uuid "$tunnel_id"; then
  printf 'No valid tunnel UUID found for %s.\n' "$tunnel_name" >&2
  exit 1
fi
if [ "$configured_id" != REPLACE_WITH_TUNNEL_UUID ] && [ "$configured_id" != "$tunnel_id" ]; then
  printf 'The tunnel UUID in %s must match the existing %s tunnel.\n' "$config" "$tunnel_name" >&2
  exit 1
fi

stage_credentials
if ! cloudflared tunnel token --cred-file "$tmp/credentials.json" "$tunnel_id" >/dev/null ||
  [ ! -s "$tmp/credentials.json" ]; then
  printf 'Cannot fetch Cloudflare credentials. Check the Cloudflare CLI login on this host.\n' >&2
  exit 1
fi
if [ "$configured_id" = REPLACE_WITH_TUNNEL_UUID ]; then
  sed "s/^tunnel:.*/tunnel: $tunnel_id/" "$config" > "$tmp/cloudflared.yml"
  mv -f -- "$tmp/cloudflared.yml" "$config"
fi
mv -f -- "$tmp/credentials.json" "$credentials"
start_tunnel --force-recreate
