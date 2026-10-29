# 外部公開する本番 Cernere の拠点作業 (spec/setup/public-exposure.md「拠点で行うこと」)。
# 拠点 (AWS) のシェルで実行する。Excubitor の terminal profile 経由で流してよい。秘密の値は表示しない。
#   1. Redis パスワードを拠点で作る ($HOME/.config/cernere/datastores.env、0600)
#   2. 拠点の Vault に LISTEN_HOST / REDIS_URL を入れ、overrides.cernere に名前を足す (本社へは送らない)
#   3. Postgres / Redis をループバック待受 + Redis パスワード必須で作り直す (データは既存 volume)
#   4. cloudflared の Tunnel トークンをプロセス引数からファイルへ移す (接続できなければ元に戻す)
# 何度流しても同じ結果になる (作成済みのものは使い回す)。
set -u
CONF="$HOME/.config/cernere"
ENVF="$CONF/datastores.env"
EX="${EXCUBITOR_URL:-http://127.0.0.1:17332}"
NODE="$(command -v node || ls "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"
TS_IP="$(tailscale ip -4 2>/dev/null | head -1)"
fail() { echo "STOP: $*"; exit 1; }
[ -n "$NODE" ] && [ -x "$NODE" ] || fail "node が見つからない"
[ -n "$TS_IP" ] || fail "tailscale の IPv4 が取れない"

echo "== 1. Redis パスワード"
install -d -m 700 "$CONF"
if [ -s "$ENVF" ]; then echo "既存を使う"; else (umask 077; printf 'REDIS_PASSWORD=%s\n' "$(openssl rand -hex 32)" > "$ENVF"); echo "作成した"; fi
REDIS_PASSWORD="$(sed -n 's/^REDIS_PASSWORD=//p' "$ENVF")"
[ "${#REDIS_PASSWORD}" -eq 64 ] || fail "REDIS_PASSWORD の形式が想定外"

echo "== 2. 拠点の Vault (上書き) に LISTEN_HOST / REDIS_URL"
put() { curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' --data-binary @- "$EX$1"; }
[ "$(printf '{"value":"127.0.0.1,::1,%s"}' "$TS_IP" | put /api/v1/vault/entries/LISTEN_HOST)" = 200 ] || fail "LISTEN_HOST の登録に失敗"
[ "$(printf '{"value":"redis://:%s@127.0.0.1:6379"}' "$REDIS_PASSWORD" | put /api/v1/vault/entries/REDIS_URL)" = 200 ] || fail "REDIS_URL の登録に失敗"
NAMES="$(curl -s "$EX/api/v1/vault" | "$NODE" -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const o = JSON.parse(s).overrides;
  const cur = Array.isArray(o) ? (o.find((x) => x.code === "cernere")?.names ?? []) : (o?.cernere ?? []);
  const names = [...new Set([...cur.map((x) => typeof x === "string" ? x : x.name), "LISTEN_HOST", "REDIS_URL"])];
  process.stdout.write(JSON.stringify({ names }));
});')" || fail "上書きの一覧を読めない"
[ "$(printf '%s' "$NAMES" | put /api/v1/vault/overrides/cernere)" = 200 ] || fail "上書きの名前の登録に失敗"
echo "上書き: $NAMES"

echo "== 3. Postgres / Redis の作り直し"
cat > "$CONF/datastores.compose.yaml" <<'YAML'
name: cernere
services:
  postgres:
    image: postgres:17-alpine
    container_name: cernere-postgres
    ports: ["127.0.0.1:5432:5432"]
    environment:
      POSTGRES_USER: cernere
      POSTGRES_DB: cernere
    volumes: [pg-data:/var/lib/postgresql/data]
    restart: unless-stopped
  redis:
    image: redis:7-alpine
    container_name: cernere-redis
    ports: ["127.0.0.1:6379:6379"]
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD:?REDIS_PASSWORD is required}
    command: ["sh", "-c", "umask 077 && printf 'requirepass %s\\nappendonly yes\\n' \"$$REDIS_PASSWORD\" > /tmp/redis.conf && exec redis-server /tmp/redis.conf"]
    volumes: [redis-data:/data]
    restart: unless-stopped
volumes:
  pg-data: {external: true, name: cernere_pg-data}
  redis-data: {external: true, name: cernere_redis-data}
YAML
for c in cernere-redis cernere-postgres; do
  if docker inspect "$c" >/dev/null 2>&1; then docker stop "$c" >/dev/null && docker rm "$c" >/dev/null || fail "$c を止められない"; fi
done
docker compose -f "$CONF/datastores.compose.yaml" --env-file "$ENVF" up -d 2>&1 | tail -3
sleep 5
echo "認証なしの ping (NOAUTH になること):"; docker exec cernere-redis redis-cli ping 2>&1 | head -1
echo "パスワード付きの ping (PONG になること):"; docker exec cernere-redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping'
docker exec cernere-postgres pg_isready -U cernere
echo "待受 (127.0.0.1 だけになっていること):"; ss -ltn | grep -E ':(5432|6379) '

echo "== 4. cloudflared のトークンをファイルへ"
DROPIN=/etc/systemd/system/cloudflared.service.d/token-file.conf
if [ -f "$DROPIN" ]; then echo "移行済み"; else
  UNIT="$(systemctl show -p FragmentPath --value cloudflared)"
  TOKEN="$(sed -n 's/^ExecStart=.*--token \([^ ]*\).*/\1/p' "$UNIT" | head -1)"
  [ -n "$TOKEN" ] || fail "cloudflared の unit に --token が無い"
  sudo install -d -m 700 /etc/cloudflared
  printf '%s' "$TOKEN" | sudo tee /etc/cloudflared/tunnel-token >/dev/null; unset TOKEN
  sudo chmod 600 /etc/cloudflared/tunnel-token
  sudo install -d "$(dirname "$DROPIN")"
  printf '[Service]\nExecStart=\nExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token-file /etc/cloudflared/tunnel-token\n' | sudo tee "$DROPIN" >/dev/null
  sudo systemctl daemon-reload && sudo systemctl restart cloudflared
  ok=0
  for _ in $(seq 1 30); do
    sleep 1
    if sudo journalctl -u cloudflared --since "-40s" --no-pager | grep -q 'Registered tunnel connection'; then ok=1; break; fi
  done
  if [ "$ok" = 1 ]; then echo "cloudflared: token-file で接続した"; else
    echo "cloudflared: 接続を確認できないので元に戻した"
    sudo rm -f "$DROPIN"
    sudo systemctl daemon-reload && sudo systemctl restart cloudflared
  fi
fi
ps -eo args | grep '[c]loudflared' | sed -E 's/(--token )[^ ]+/\1***/'
echo "== 完了 (次: 本社の Vault で CERNERE_IDENTITY_VERIFICATION_DISABLED を外し、cernere → cernere-frontend を deploy)"
