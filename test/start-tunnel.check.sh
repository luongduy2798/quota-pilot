#!/bin/sh
set -eu

starter=$(cd "$(dirname "$0")/.." && pwd)/scripts/start-tunnel.sh
fixture=$(mktemp -d)
trap 'rm -r -- "$fixture"' EXIT
cd "$fixture"
mkdir bin deploy
export PATH="$fixture/bin:$PATH"
export TUNNEL_ID=00000000-0000-4000-8000-000000000001
export TUNNEL_ERROR='Unauthorized: Invalid tunnel secret'
printf 'tunnel: %s\n' "$TUNNEL_ID" > deploy/cloudflared.yml
printf 'stale\n' > deploy/cloudflared-credentials.json

cat > bin/docker <<'SH'
#!/bin/sh
case " $* " in
  *' logs '*) printf '%s\n' "$TUNNEL_ERROR" >&2 ;;
  *' --force-recreate '*)
    test "$(cat deploy/cloudflared-credentials.json)" = fresh || exit 1
    printf 'recreated\n' >> calls
    ;;
  *' up '*) exit 1 ;;
  *) exit 2 ;;
esac
SH
cat > bin/cloudflared <<'SH'
#!/bin/sh
case "$2" in
  list) printf '%s quota-pilot\n' "$TUNNEL_ID" ;;
  token)
    test "$5" = "$TUNNEL_ID" || exit 1
    printf 'fresh\n' > "$4"
    printf 'fetched\n' >> calls
    ;;
  *) exit 2 ;;
esac
SH
chmod +x bin/docker bin/cloudflared

sh "$starter" quota-pilot
test "$(cat calls)" = "$(printf 'fetched\nrecreated\n')"

export TUNNEL_ERROR='Connection timed out'
if sh "$starter" quota-pilot; then exit 1; fi
test "$(cat calls)" = "$(printf 'fetched\nrecreated\n')"

printf 'tunnel: REPLACE_WITH_TUNNEL_UUID\n' > deploy/cloudflared.yml
sh "$starter" quota-pilot
grep -Fxq "tunnel: $TUNNEL_ID" deploy/cloudflared.yml
test "$(cat calls)" = "$(printf 'fetched\nrecreated\nfetched\nrecreated\n')"
