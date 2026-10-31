#!/usr/bin/env bash
# Prueba de punta a punta de la etapa 1: nube local (Supabase local + next dev) + EMQX en Docker +
# agente `acceso-cloud` del panel contra una base v6 temporal. Todo es LOCAL: nunca toca el proyecto
# remoto ni Vercel. Ver cloud/e2e/README.md. Termina con `E2E OK` (y código 0) si todo pasa.
#
# Requisitos: Docker, `supabase start` corriendo en cloud/, psql, sqlite3, openssl, curl, perl,
# python3 y el entorno del panel (panel/backend/.venv con las dependencias instaladas).
#
# Qué NO hace: no ejecuta `supabase db reset` ni `supabase stop`, no toca cloud/.env.local,
# panel/backend/.env ni panel/backend/data, y no detiene procesos que no lanzó él. Sus datos llevan
# el nombre "E2E <hex>" y se borran al terminar (también si falla).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$CLOUD_DIR/.." && pwd)"
PANEL_PY="${PANEL_PYTHON:-$REPO_ROOT/panel/backend/.venv/bin/python}"

# Puertos del E2E (distintos de los del dueño: 3000 interfaz del panel local, 8883/18083 EMQX de
# desarrollo). Se pueden cambiar por entorno; si están ocupados el script falla sin tocar nada.
E2E_PORT="${E2E_PORT:-3100}"
E2E_MQTT_PORT="${E2E_MQTT_PORT:-18883}"
E2E_EMQX_API_PORT="${E2E_EMQX_API_PORT:-18084}"
E2E_WSS_PORT="${E2E_WSS_PORT:-18443}"
EMQX_IMAGE="emqx/emqx:5.8.6"
# Intervalo periódico del agente: grande mientras se prueba el aviso MQTT (así una tarjeta de la nube
# solo puede llegar a tiempo por el aviso) y corto (SYNC_INTERVAL) en la fase sin EMQX, que prueba
# justamente la sincronización periódica.
NOTICE_INTERVAL="${E2E_NOTICE_INTERVAL_S:-300}"
SYNC_INTERVAL="${E2E_SYNC_INTERVAL_S:-20}"
BATCH_N=500

ID="$(openssl rand -hex 3)"
TMP=""
NEXT_PID=""
AGENT_PID=""
EMQX_NAME="acceso-e2e-emqx-$ID"
EMQX_PROJECT="acceso-e2e-$ID"
EMQX_COMPOSE=()   # docker compose -p ... -f ... (se arma en start_emqx)
T_ID="" ; I_ID="" ; USER_ID="" ; PANEL_CODE=""
VAULT_TOUCHED=0 ; VAULT_URL_ID="" ; VAULT_SEC_ID="" ; VAULT_OLD_URL="" ; VAULT_OLD_SEC=""
CLEANED=0
RESULTS=""
BASELINE=""

# ----------------------------------------------------------------------------- utilidades
log()  { printf '[e2e %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '[e2e %s] OK  %s\n' "$(date +%H:%M:%S)" "$*"; RESULTS="$RESULTS
  - $*"; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time()*1000'; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f", (b - a) / 1000 }'; }

tail_logs() {
  local f
  for f in next agent; do
    if [ -n "$TMP" ] && [ -f "$TMP/$f.log" ]; then
      printf '\n----- últimas líneas de %s.log -----\n' "$f"
      tail -n 40 "$TMP/$f.log"
    fi
  done
  if docker inspect "$EMQX_NAME" >/dev/null 2>&1; then
    printf '\n----- últimas líneas del log de EMQX -----\n'
    docker logs --tail 40 "$EMQX_NAME" 2>&1
  fi
}

fail() {
  printf '\n[e2e] FALLÓ: %s\n' "$*" >&2
  tail_logs >&2
  exit 1
}

sql() { psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -At "$@"; }
panel_sql() { sqlite3 -cmd '.timeout 5000' "$TMP/panel.sqlite" "$1"; }
jget() { python3 -I -c 'import sys, json; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
tool() { "$PANEL_PY" -I "$HERE/panel_tool.py" "$@"; }
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# wait_until <timeout_s> <descripción> <función> [args...]: reintenta cada 0,25 s. Deja el tiempo
# que tardó (s) en $WAITED. Falla con mensaje claro si vence.
WAITED=0
wait_until() {
  local timeout="$1" desc="$2" t0 t
  shift 2
  t0="$(now_ms)"
  while :; do
    if "$@"; then
      WAITED="$(secs "$t0" "$(now_ms)")"
      return 0
    fi
    t="$(now_ms)"
    if [ $(( t - t0 )) -gt $(( timeout * 1000 )) ]; then
      fail "venció el plazo de ${timeout} s esperando: $desc"
    fi
    sleep 0.25
  done
}
# Igual, pero devuelve 1 en vez de fallar (para medir sin abortar).
under() { # <límite_s> <elapsed_s>
  awk -v e="$2" -v l="$1" 'BEGIN { exit !(e < l) }'
}

# ----------------------------------------------------------------------------- limpieza
kill_group() { # <pid> <nombre>
  local pid="$1" i
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  for i in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  return 0
}

cleanup() {
  [ "$CLEANED" = 1 ] && return 0
  CLEANED=1
  local status=0
  log "Limpieza: deteniendo lo que lanzó el E2E y borrando sus datos"
  kill_group "$AGENT_PID" agente
  kill_group "$NEXT_PID" "next dev"
  if [ ${#EMQX_COMPOSE[@]} -gt 0 ]; then
    "${EMQX_COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  fi
  if docker inspect "$EMQX_NAME" >/dev/null 2>&1; then
    docker rm -f -v "$EMQX_NAME" >/dev/null 2>&1 || { log "AVISO: no se pudo borrar el contenedor $EMQX_NAME"; status=1; }
  fi

  if [ -n "${DB_URL:-}" ] && { [ -n "$T_ID" ] || [ -n "$PANEL_CODE" ] || [ "$VAULT_TOUCHED" = 1 ]; }; then
    if [ -n "$T_ID" ]; then
      # Panel y datos del tenant del E2E, solo por los ids que creó este script.
      sql -v t="$T_ID" -v i="$I_ID" -v code="$PANEL_CODE" <<'SQL' || { log "AVISO: no se pudieron borrar los datos del E2E en la base local"; status=1; }
begin;
delete from public.outputs where installation_id = :'i'::uuid;
delete from public.profile_panel_rules where installation_id = :'i'::uuid;
delete from public.panels where installation_id = :'i'::uuid or panel_code = :'code';
delete from public.tenants where id = :'t'::uuid;
commit;
SQL
    elif [ -n "$PANEL_CODE" ]; then
      sql -v code="$PANEL_CODE" <<'SQL' || status=1
delete from public.panels where panel_code = :'code' and installation_id is null;
SQL
    fi
    if [ "$VAULT_TOUCHED" = 1 ]; then
      restore_vault || status=1
    fi
  fi
  if [ -n "$USER_ID" ] && [ -n "${API_URL:-}" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API_URL/auth/v1/admin/users/$USER_ID" \
      -H "apikey: $SECRET_KEY" -H "Authorization: Bearer $SECRET_KEY")"
    case "$code" in 2*) ;; *) log "AVISO: no se pudo borrar el usuario E2E (HTTP $code)"; status=1 ;; esac
  fi
  if [ -n "$TMP" ] && [ -f "$TMP/next-env.d.ts.orig" ]; then
    cp -p "$TMP/next-env.d.ts.orig" "$CLOUD_DIR/next-env.d.ts" || { log "AVISO: no se pudo restaurar next-env.d.ts"; status=1; }
  fi
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi
  return $status
}
trap 'cleanup' EXIT
trap 'exit 130' INT TERM

restore_vault() {
  local rc=0
  if [ -n "$VAULT_URL_ID" ]; then
    sql -v id="$VAULT_URL_ID" -v v="$VAULT_OLD_URL" <<'SQL' >/dev/null || rc=1
select vault.update_secret(:'id'::uuid, :'v');
SQL
  else
    sql -c "delete from vault.secrets where name = 'app_url'" >/dev/null || rc=1
  fi
  if [ -n "$VAULT_SEC_ID" ]; then
    sql -v id="$VAULT_SEC_ID" -v v="$VAULT_OLD_SEC" <<'SQL' >/dev/null || rc=1
select vault.update_secret(:'id'::uuid, :'v');
SQL
  else
    sql -c "delete from vault.secrets where name = 'internal_webhook_secret'" >/dev/null || rc=1
  fi
  [ "$rc" = 0 ] || log "AVISO: no se pudo restaurar Vault"
  return $rc
}

counts() {
  sql <<'SQL'
select concat_ws(' ',
  'tenants=' || (select count(*) from public.tenants),
  'tenant_members=' || (select count(*) from public.tenant_members),
  'installations=' || (select count(*) from public.installations),
  'panels=' || (select count(*) from public.panels),
  'holders=' || (select count(*) from public.holders),
  'cards=' || (select count(*) from public.cards),
  'controls=' || (select count(*) from public.controls),
  'control_buttons=' || (select count(*) from public.control_buttons),
  'control_button_panels=' || (select count(*) from public.control_button_panels),
  'access_profiles=' || (select count(*) from public.access_profiles),
  'holder_profiles=' || (select count(*) from public.holder_profiles),
  'profile_panel_rules=' || (select count(*) from public.profile_panel_rules),
  'outputs=' || (select count(*) from public.outputs),
  'access_logs=' || (select count(*) from public.access_logs),
  'audit_log=' || (select count(*) from public.audit_log),
  'device_changes=' || (select count(*) from public.device_changes),
  'sync_conflicts=' || (select count(*) from public.sync_conflicts),
  'panel_imports=' || (select count(*) from public.panel_imports),
  'panel_claim_attempts=' || (select count(*) from public.panel_claim_attempts),
  'panel_commands=' || (select count(*) from public.panel_commands),
  'auth_users=' || (select count(*) from auth.users),
  'vault_secrets=' || (select count(*) from vault.secrets));
SQL
}

# ----------------------------------------------------------------------------- comprobaciones previas
preflight() {
  local cmd
  for cmd in docker psql sqlite3 openssl curl perl python3 lsof supabase; do
    command -v "$cmd" >/dev/null 2>&1 || fail "falta el comando '$cmd' en el PATH"
  done
  [ -x "$PANEL_PY" ] || fail "no existe $PANEL_PY (crea el entorno del panel: panel/README.md)"
  "$PANEL_PY" -I -c 'import acceso.cloud, paho.mqtt, httpx' 2>/dev/null \
    || fail "el Python del panel no puede importar acceso.cloud, paho-mqtt y httpx"
  docker info >/dev/null 2>&1 || fail "Docker no responde: ábrelo e inténtalo de nuevo"

  # Llaves y URLs del Supabase local (no se lee cloud/.env.local).
  local status_env
  status_env="$(cd "$CLOUD_DIR" && supabase status -o env 2>/dev/null)" \
    || fail "Supabase local no está corriendo: ejecuta 'supabase start' en cloud/"
  eval "$status_env"
  : "${API_URL:?}" "${DB_URL:?}" "${PUBLISHABLE_KEY:?}" "${SECRET_KEY:?}"
  case "$API_URL$DB_URL" in
    *127.0.0.1*|*localhost*) ;;
    *) fail "el Supabase detectado no es local ($API_URL): el E2E solo corre en local" ;;
  esac
  sql -c 'select 1' >/dev/null || fail "no se pudo conectar a la base local ($DB_URL)"

  local p
  for p in "$E2E_PORT" "$E2E_MQTT_PORT" "$E2E_EMQX_API_PORT" "$E2E_WSS_PORT"; do
    ! port_busy "$p" || fail "el puerto $p está ocupado (el E2E no detiene procesos ajenos): libéralo o cambia E2E_PORT / E2E_MQTT_PORT / E2E_EMQX_API_PORT / E2E_WSS_PORT"
  done
  if ! docker image inspect "$EMQX_IMAGE" >/dev/null 2>&1; then
    log "Descargando la imagen $EMQX_IMAGE (una sola vez)"
    docker pull "$EMQX_IMAGE" >/dev/null || fail "no se pudo descargar $EMQX_IMAGE"
  fi
}

# ----------------------------------------------------------------------------- preparación
make_certs() {
  # CA y certificado de servidor para localhost: el agente solo acepta mqtts:// y verifica con
  # los CA del sistema; se le da esta CA con SSL_CERT_FILE.
  mkdir -p "$TMP/certs" && cd "$TMP/certs" || fail "no se pudo crear $TMP/certs"
  cat >ca.cnf <<'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = Acceso E2E CA
[v3_ca]
basicConstraints = critical,CA:true
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF
  cat >server.ext <<'EOF'
basicConstraints = CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF
  { openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 2 -config ca.cnf \
    && openssl req -newkey rsa:2048 -nodes -keyout privkey.pem -out server.csr -subj '/CN=localhost' \
    && openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem \
         -days 2 -extfile server.ext \
    && cat server.pem ca.pem > fullchain.pem; } >/dev/null 2>&1 || fail "no se pudieron generar los certificados de prueba"
  # Llaves desechables: legibles para el usuario del contenedor (Docker Desktop no respeta el dueño
  # del anfitrión). En un servidor real la llave va con dueño uid 1000 y modo 0600 (despliegue.md).
  chmod 755 "$TMP" "$TMP/certs"; chmod 644 privkey.pem fullchain.pem ca.pem
  cd "$HERE" || true
}

start_agent() { # <SYNC_INTERVAL_S>: el log del agente se acumula en $TMP/agent.log
  log "Arrancando el agente acceso-cloud (SYNC_INTERVAL_S=$1)"
  (
    cd "$TMP" || exit 1
    exec env \
      ACCESO_ENV_FILE="$TMP/ninguno.env" \
      DB_PATH="$TMP/panel.sqlite" \
      CLOUD_CREDENTIALS_PATH="$TMP/cloud.env" \
      CLOUD_URL="http://localhost:$E2E_PORT" \
      MQTT_URL="mqtts://localhost:$E2E_MQTT_PORT" \
      SSL_CERT_FILE="$TMP/certs/ca.pem" \
      SYNC_INTERVAL_S="$1" \
      NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 \
      PYTHONUNBUFFERED=1 \
      "$PANEL_PY" -I -m acceso.cloud
  ) >>"$TMP/agent.log" 2>&1 &
  AGENT_PID=$!
}

# Busca un texto fijo en el log de EMQX. Captura el log primero: un pipe a `grep -q` bajo pipefail
# puede morir por SIGPIPE y ocultar el resultado.
emqx_log_has() {
  local out
  out="$(docker logs "$EMQX_NAME" 2>&1)" || fail "no se pudo leer el log de EMQX"
  case "$out" in *"$1"*) return 0 ;; *) return 1 ;; esac
}

start_next() {
  # `next dev` reescribe cloud/next-env.d.ts (ignorado por git): se restaura al terminar.
  if [ -f "$CLOUD_DIR/next-env.d.ts" ]; then cp -p "$CLOUD_DIR/next-env.d.ts" "$TMP/next-env.d.ts.orig"; fi
  log "Arrancando next dev en el puerto $E2E_PORT (primera compilación: puede tardar)"
  (
    cd "$CLOUD_DIR" || exit 1
    exec env \
      NEXT_TELEMETRY_DISABLED=1 \
      NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" \
      SUPABASE_SECRET_KEY="$SECRET_KEY" \
      PIN_ENC_KEY="$(openssl rand -base64 32)" \
      PIN_LOOKUP_KEY="$(openssl rand -base64 32)" \
      APP_URL="http://localhost:$E2E_PORT" \
      EMQX_API_URL="http://127.0.0.1:$E2E_EMQX_API_PORT" \
      EMQX_API_KEY="$EMQX_KEY" \
      EMQX_API_SECRET="$EMQX_SECRET" \
      EMQX_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
      INTERNAL_WEBHOOK_SECRET="$INTERNAL_SECRET" \
      python3 -I -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
      node_modules/.bin/next dev -p "$E2E_PORT"
  ) >"$TMP/next.log" 2>&1 &
  NEXT_PID=$!
}

route_status() { # <método> <ruta> [encabezado]
  curl -s -o /dev/null -m 120 -w '%{http_code}' -X "$1" "http://localhost:$E2E_PORT$2" \
    -H 'content-type: application/json' -d '{}' ${3:+-H "$3"} 2>/dev/null
}
next_ready() { [ "$(route_status POST /api/mqtt/auth "x-emqx-secret: $WEBHOOK_SECRET")" = 200 ]; }

warm_routes() {
  # En `next dev` cada ruta compila en su primera petición: se "calientan" para que esa compilación
  # no cuente en los plazos de las comprobaciones (en producción no existe).
  local r
  for r in /api/mqtt/events /api/internal/revision-changed /api/device/v1/register /api/device/v1/activate \
           /api/device/v1/link-state /api/device/v1/import-snapshot /api/device/v1/changes \
           /api/device/v1/logs /api/device/v1/checksums /api/device/v1/snapshot /api/device/v1/alerts; do
    route_status POST "$r" >/dev/null
    route_status GET "$r" >/dev/null
  done
}

start_emqx() {
  log "Arrancando EMQX con el docker-compose.yml de infra/emqx (emqx.conf renderizado por render-entrypoint.sh)"
  local infra="$CLOUD_DIR/infra/emqx"
  # Variables del compose (equivalen al .env de un servidor real) y un override que solo agrega la
  # API key de la prueba por archivo de arranque (en producción se crea en el dashboard).
  cat >"$TMP/emqx.env" <<ENV
APP_URL=http://host.docker.internal:$E2E_PORT
EMQX_WEBHOOK_SECRET=$WEBHOOK_SECRET
EMQX_NODE_COOKIE=e2e-$ID
EMQX_DASHBOARD_USER=admin
EMQX_DASHBOARD_PASSWORD=$(openssl rand -hex 8)
EMQX_CERT_DIR=$TMP/certs
EMQX_CONTAINER_NAME=$EMQX_NAME
EMQX_MQTT_PORT=$E2E_MQTT_PORT
EMQX_WSS_PORT=$E2E_WSS_PORT
EMQX_API_PORT=$E2E_EMQX_API_PORT
ENV
  cat >"$TMP/compose.e2e.yml" <<YML
services:
  emqx:
    environment:
      EMQX_API_KEY__BOOTSTRAP_FILE: /opt/emqx/etc/api_bootstrap.txt
    volumes:
      - $TMP/api_bootstrap.txt:/opt/emqx/etc/api_bootstrap.txt:ro
YML
  EMQX_COMPOSE=(docker compose -p "$EMQX_PROJECT" --env-file "$TMP/emqx.env"
                -f "$infra/docker-compose.yml" -f "$TMP/compose.e2e.yml")
  "${EMQX_COMPOSE[@]}" up -d >/dev/null 2>&1 || {
    "${EMQX_COMPOSE[@]}" up -d 2>&1 | tail -n 15 >&2
    fail "no se pudo arrancar EMQX con docker compose"
  }
}
emqx_ready() {
  [ "$(docker inspect -f '{{.State.Running}}' "$EMQX_NAME" 2>/dev/null)" = true ] \
    || fail "el contenedor de EMQX se detuvo al arrancar (¿configuración inválida?)"
  [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' -u "$EMQX_KEY:$EMQX_SECRET" \
      "http://127.0.0.1:$E2E_EMQX_API_PORT/api/v5/listeners")" = 200 ]
}

set_vault() {
  # El trigger de avisos (pg_net, dentro del contenedor de la base) lee estos dos secretos.
  VAULT_URL_ID="$(sql -c "select id from vault.secrets where name = 'app_url'")"
  VAULT_SEC_ID="$(sql -c "select id from vault.secrets where name = 'internal_webhook_secret'")"
  VAULT_OLD_URL="$(sql -c "select decrypted_secret from vault.decrypted_secrets where name = 'app_url'")"
  VAULT_OLD_SEC="$(sql -c "select decrypted_secret from vault.decrypted_secrets where name = 'internal_webhook_secret'")"
  VAULT_TOUCHED=1
  local url="http://host.docker.internal:$E2E_PORT"
  if [ -n "$VAULT_URL_ID" ]; then
    sql -v id="$VAULT_URL_ID" -v v="$url" <<'SQL' >/dev/null || fail "no se pudo actualizar el secreto app_url de Vault"
select vault.update_secret(:'id'::uuid, :'v');
SQL
  else
    sql -v v="$url" <<'SQL' >/dev/null || fail "no se pudo crear el secreto app_url de Vault"
select vault.create_secret(:'v', 'app_url');
SQL
  fi
  if [ -n "$VAULT_SEC_ID" ]; then
    sql -v id="$VAULT_SEC_ID" -v v="$INTERNAL_SECRET" <<'SQL' >/dev/null || fail "no se pudo actualizar internal_webhook_secret"
select vault.update_secret(:'id'::uuid, :'v');
SQL
  else
    sql -v v="$INTERNAL_SECRET" <<'SQL' >/dev/null || fail "no se pudo crear internal_webhook_secret"
select vault.create_secret(:'v', 'internal_webhook_secret');
SQL
  fi
}

create_cloud_org() {
  T_ID="$(uuidgen | tr 'A-Z' 'a-z')"
  I_ID="$(uuidgen | tr 'A-Z' 'a-z')"
  USER_EMAIL="e2e-$ID@local.test"
  USER_PASSWORD="$(openssl rand -hex 12)"
  local body resp
  body="$(printf '{"email":"%s","password":"%s","email_confirm":true}' "$USER_EMAIL" "$USER_PASSWORD")"
  resp="$(curl -s -m 30 -X POST "$API_URL/auth/v1/admin/users" -H "apikey: $SECRET_KEY" \
    -H "Authorization: Bearer $SECRET_KEY" -H 'content-type: application/json' -d "$body")" \
    || fail "no se pudo crear el usuario E2E en Auth local"
  USER_ID="$(printf '%s' "$resp" | jget id 2>/dev/null)" || fail "Auth local no devolvió el usuario E2E"
  sql -v t="$T_ID" -v i="$I_ID" -v u="$USER_ID" -v tn="E2E $ID" -v inn="E2E instalación $ID" <<'SQL' >/dev/null \
    || fail "no se pudieron crear el tenant, el administrador y la instalación E2E"
begin;
insert into public.tenants (id, name) values (:'t'::uuid, :'tn');
insert into public.tenant_members (tenant_id, user_id, role) values (:'t'::uuid, :'u'::uuid, 'admin');
insert into public.installations (id, tenant_id, name) values (:'i'::uuid, :'t'::uuid, :'inn');
commit;
SQL
  resp="$(curl -s -m 30 -X POST "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $PUBLISHABLE_KEY" \
    -H 'content-type: application/json' \
    -d "$(printf '{"email":"%s","password":"%s"}' "$USER_EMAIL" "$USER_PASSWORD")")"
  USER_JWT="$(printf '%s' "$resp" | jget access_token 2>/dev/null)" || fail "no se pudo iniciar sesión como el administrador E2E"
}

# Alta de tarjeta "desde la interfaz": el cliente de la sesión del usuario, bajo RLS (el trigger
# pone updated_by, origin='cloud' y la revisión). Idéntico a lo que hace src/lib/cards.ts.
cloud_add_card() { # <código>
  local code
  code="$(curl -s -o /dev/null -m 30 -w '%{http_code}' -X POST "$API_URL/rest/v1/cards" \
    -H "apikey: $PUBLISHABLE_KEY" -H "Authorization: Bearer $USER_JWT" \
    -H 'content-type: application/json' -H 'Prefer: return=minimal' \
    -d "$(printf '{"installation_id":"%s","card_code":%s,"holder_id":"%s","description":"Tarjeta E2E de la nube"}' "$I_ID" "$1" "$HOLDER_UUID")")"
  [ "$code" = 201 ] || fail "la nube rechazó el alta de la tarjeta $1 (HTTP $code)"
}

# ----------------------------------------------------------------------------- condiciones
cloud_panel_status_is() { [ "$(sql -c "select status from public.panels where panel_code = '$PANEL_CODE'")" = "$1" ]; }
cloud_panel_online()    { [ "$(sql -c "select online from public.panels where panel_code = '$PANEL_CODE'")" = t ]; }
cloud_card_exists()     { [ "$(sql -c "select count(*) from public.cards where installation_id = '$I_ID' and card_code = $1 and deleted_at is null")" = 1 ]; }
cloud_log_exists()      { [ "$(sql -c "select count(*) from public.access_logs where installation_id = '$I_ID' and local_log_id = $1")" = 1 ]; }
panel_card_exists()     { [ "$(panel_sql "select count(*) from cards where card_code = $1")" = 1 ]; }
panel_row_registered()  { [ "$(sql -c "select count(*) from public.panels where panel_code = '$PANEL_CODE'")" = 1 ]; }

# ----------------------------------------------------------------------------- flujo principal
main() {
  preflight
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/acceso-e2e.XXXXXX")" || fail "no se pudo crear el directorio temporal"
  TMP="$(cd "$TMP" && pwd -P)"
  log "E2E $ID — directorio temporal: $TMP"
  BASELINE="$(counts)" || fail "no se pudo leer la base local"

  EMQX_KEY="e2e$ID"
  EMQX_SECRET="$(openssl rand -hex 16)"
  WEBHOOK_SECRET="$(openssl rand -hex 16)"
  INTERNAL_SECRET="$(openssl rand -hex 16)"
  printf '%s:%s\n' "$EMQX_KEY" "$EMQX_SECRET" >"$TMP/api_bootstrap.txt"
  chmod 644 "$TMP/api_bootstrap.txt"
  make_certs

  # Panel: base v6 temporal con 1 titular y 1 tarjeta (la identidad se genera aquí, igual que
  # hará el agente al arrancar).
  local init
  init="$(tool init "$TMP/panel.sqlite")" || fail "no se pudo crear la base temporal del panel"
  PANEL_CODE="$(printf '%s' "$init" | jget panel_code)"
  CLAIM_CODE="$(printf '%s' "$init" | jget claim_code)"
  HOLDER_UUID="$(printf '%s' "$init" | jget holder_uuid)"
  INITIAL_CARD="$(printf '%s' "$init" | jget card_code)"
  log "Panel de prueba: $PANEL_CODE (base v6 temporal)"

  start_next
  wait_until 180 "que next dev responda en el puerto $E2E_PORT" next_ready
  ok "next dev listo en el puerto $E2E_PORT (${WAITED} s)"
  warm_routes

  start_emqx
  wait_until 120 "que EMQX responda en su API" emqx_ready
  ok "EMQX listo (API en 127.0.0.1:$E2E_EMQX_API_PORT, MQTT/TLS en $E2E_MQTT_PORT) (${WAITED} s)"

  set_vault
  create_cloud_org
  ok "tenant 'E2E $ID', administrador $USER_EMAIL e instalación creados"

  # --- el agente ---
  start_agent "$NOTICE_INTERVAL"

  wait_until 60 "que el panel se registre en la nube (pending)" panel_row_registered
  cloud_panel_status_is pending || fail "el panel se registró pero no quedó 'pending'"
  ok "el panel se registró en la nube como pending (${WAITED} s)"

  # --- reclamar por SQL como claimPanel: verifica sha256(claim_code) y llama a claim_panel ---
  local claimed
  claimed="$(sql -v code="$PANEL_CODE" -v claim="$CLAIM_CODE" -v inst="$I_ID" <<'SQL'
select public.claim_panel(p.id, p.claim_code_hash, :'inst'::uuid)
from public.panels p
where p.panel_code = :'code'
  and p.status = 'pending'
  and p.claim_code_hash = encode(sha256(convert_to(upper(trim(:'claim')), 'UTF8')), 'hex');
SQL
)" || fail "el reclamo por SQL falló"
  [ -n "$claimed" ] || fail "claim_panel no reclamó el panel (código de vinculación distinto o panel no pendiente)"
  CLAIM_CODE=""
  ok "panel reclamado por SQL (misma actualización que claimPanel)"

  wait_until 120 "que el panel quede 'active' en la nube" cloud_panel_status_is active
  ok "el panel quedó active (${WAITED} s desde el reclamo)"

  # --- datos del panel en la nube ---
  [ "$(sql -c "select count(*) from public.holders where installation_id = '$I_ID' and id = '$HOLDER_UUID' and deleted_at is null")" = 1 ] \
    || fail "el titular del panel no apareció en la nube con su UUID"
  cloud_card_exists "$INITIAL_CARD" || fail "la tarjeta inicial del panel no apareció en la nube"
  [ "$(sql -c "select count(*) from public.holders where installation_id = '$I_ID' and deleted_at is null")" = 1 ] \
    || fail "la nube tiene titulares de más tras la importación"
  [ "$(panel_sql "select value from sync_state where key = 'state'")" = active ] || fail "el agente no guardó el estado 'active'"
  ok "los datos del panel (1 titular y 1 tarjeta) aparecen en la nube con sus UUID"

  wait_until 30 "que el panel aparezca en línea (evento de conexión de EMQX)" cloud_panel_online
  grep -q 'Conectado a MQTT' "$TMP/agent.log" || fail "el agente no registró 'Conectado a MQTT' (¿falló TLS o la autenticación?)"
  ok "el agente conectó a MQTT con TLS y EMQX lo reportó en línea (panels.online = true) (${WAITED} s)"

  # La configuración de infra/emqx no debe dejar errores de arranque (p. ej. cacert.pem por defecto).
  ! emqx_log_has 'cert_file_not_found' || fail "EMQX registró cert_file_not_found al abrir los listeners TLS"
  ! emqx_log_has 'failed_to_resolve' || fail "EMQX no pudo resolver variables del emqx.conf"
  ! emqx_log_has "$WEBHOOK_SECRET" || fail "el log de EMQX contiene el secreto del webhook"
  emqx_log_has 'is running now' || fail "el log de EMQX no indica que haya arrancado"

  # --- nube -> panel (aviso MQTT) ---
  # El agente corre con SYNC_INTERVAL_S=$NOTICE_INTERVAL: su ciclo periódico no puede caer dentro de
  # los 10 s de la comprobación, así que la tarjeta solo llega a tiempo si el aviso MQTT funciona
  # (trigger pg_net -> aplicación -> API de EMQX -> agente).
  wait_until 20 "a que se estabilice la bandeja de salida del panel" bash -c "[ \"\$(sqlite3 '$TMP/panel.sqlite' 'select count(*) from sync_outbox')\" = 0 ]"
  local c1=4000000002 t0
  t0="$(now_ms)"
  cloud_add_card "$c1"
  wait_until 10 "que la tarjeta $c1 dada de alta en la nube llegue al panel" panel_card_exists "$c1"
  local t_cloud_to_panel="$WAITED"
  under 10 "$t_cloud_to_panel" || fail "la tarjeta de la nube tardó ${t_cloud_to_panel} s (límite 10 s)"
  under "$NOTICE_INTERVAL" "$t_cloud_to_panel" || fail "la comprobación del aviso MQTT no es válida: tardó tanto como el intervalo periódico"
  # Sin eco: aplicar cambios de la nube no debe dejar entradas en la bandeja de salida.
  [ "$(panel_sql "select count(*) from sync_outbox")" = 0 ] || fail "la bandeja de salida tiene entradas tras aplicar un cambio de la nube (eco)"
  ok "nube -> panel: la tarjeta $c1 llegó en ${t_cloud_to_panel} s por aviso MQTT, sin eco en la bandeja"

  # --- panel -> nube (bandeja + push) y log ---
  local c2=4000000003 log_id
  log_id="$(tool add-log "$TMP/panel.sqlite" 4000000001 | jget log_id)" || fail "no se pudo crear el log del panel"
  tool add-card "$TMP/panel.sqlite" "$c2" >/dev/null || fail "no se pudo dar de alta la tarjeta en el panel"
  wait_until 10 "que la tarjeta $c2 dada de alta en el panel llegue a la nube" cloud_card_exists "$c2"
  local t_panel_to_cloud="$WAITED"
  under 10 "$t_panel_to_cloud" || fail "la tarjeta del panel tardó ${t_panel_to_cloud} s (límite 10 s)"
  ok "panel -> nube: la tarjeta $c2 llegó en ${t_panel_to_cloud} s"
  wait_until 10 "que el log $log_id del panel aparezca en la nube" cloud_log_exists "$log_id"
  [ "$(sql -c "select count(*) from public.access_logs where installation_id = '$I_ID' and local_log_id = $log_id and code = 4000000001 and allowed and holder_id = '$HOLDER_UUID'")" = 1 ] \
    || fail "el log llegó a la nube con datos distintos a los del panel"
  ok "el log $log_id del panel aparece en la nube con su titular (${WAITED} s)"

  # --- respaldo periódico con EMQX detenido ---
  log "Deteniendo EMQX y reiniciando el agente con SYNC_INTERVAL_S=$SYNC_INTERVAL para probar la sincronización de respaldo"
  docker stop "$EMQX_NAME" >/dev/null || fail "no se pudo detener EMQX"
  kill_group "$AGENT_PID" agente
  start_agent "$SYNC_INTERVAL"
  sleep 4   # su primer ciclo corre al arrancar; el siguiente llega en SYNC_INTERVAL_S
  local c3=4000000004 c4=4000000005 log2
  cloud_add_card "$c3"
  wait_until $(( SYNC_INTERVAL * 2 + 15 )) "que la tarjeta $c3 de la nube llegue al panel sin MQTT" panel_card_exists "$c3"
  local t_backup_down="$WAITED"
  ok "con EMQX detenido, nube -> panel: la tarjeta $c3 llegó en ${t_backup_down} s (sincronización periódica)"
  log2="$(tool add-log "$TMP/panel.sqlite" 4000000001 | jget log_id)" || fail "no se pudo crear el segundo log"
  tool add-card "$TMP/panel.sqlite" "$c4" >/dev/null || fail "no se pudo dar de alta la tarjeta $c4 en el panel"
  wait_until $(( SYNC_INTERVAL * 2 + 15 )) "que la tarjeta $c4 del panel llegue a la nube sin MQTT" cloud_card_exists "$c4"
  local t_backup_up="$WAITED"
  wait_until 15 "que el log $log2 llegue a la nube sin MQTT" cloud_log_exists "$log2"
  ok "con EMQX detenido, panel -> nube: la tarjeta $c4 llegó en ${t_backup_up} s y su log también"

  # --- mediciones de lote (agente detenido: se usa el mismo SyncEngine contra la misma API) ---
  log "Deteniendo el agente para medir lotes de $BATCH_N cambios"
  kill_group "$AGENT_PID" agente
  AGENT_PID=""
  local push pull
  push="$(tool measure-push "$TMP/panel.sqlite" "$TMP/cloud.env" "http://localhost:$E2E_PORT" "$BATCH_N")" \
    || fail "falló la medición del push de $BATCH_N cambios"
  [ "$(sql -c "select count(*) from public.cards where installation_id = '$I_ID' and deleted_at is null and card_code between 3000000000 and $(( 3000000000 + BATCH_N - 1 ))")" = "$BATCH_N" ] \
    || fail "tras el push de lote, la nube no tiene las $BATCH_N tarjetas"
  ok "push de $BATCH_N cambios: $push"
  sql -v i="$I_ID" -v h="$HOLDER_UUID" -v by="user:$USER_ID" -v n="$BATCH_N" <<'SQL' >/dev/null || fail "no se pudo preparar el lote de la nube"
insert into public.cards (installation_id, card_code, holder_id, description, updated_by, origin)
select :'i'::uuid, 3500000000 + g, :'h'::uuid, 'Lote E2E de la nube', :'by', 'cloud'
from generate_series(1, :n) g;
SQL
  pull="$(tool measure-pull "$TMP/panel.sqlite" "$TMP/cloud.env" "http://localhost:$E2E_PORT" "$BATCH_N")" \
    || fail "falló la medición del pull de $BATCH_N cambios"
  ok "pull de $BATCH_N cambios: $pull"

  # --- el agente no debe haber fallado con una excepción ---
  ! grep -q 'Traceback' "$TMP/agent.log" || fail "el log del agente contiene una excepción (Traceback)"
  ! grep -q 'Traceback' "$TMP/next.log" || log "AVISO: el log de next dev contiene un Traceback"

  # --- limpieza y comprobación de que el entorno quedó como estaba ---
  cleanup || fail "la limpieza dejó restos (ver avisos arriba)"
  local after
  after="$(counts)" || fail "no se pudo leer la base local tras la limpieza"
  if [ "$after" != "$BASELINE" ]; then
    log "AVISO: los conteos de la base local difieren de los iniciales (¿otro proceso escribió mientras corría el E2E?)"
    log "  antes:   $BASELINE"
    log "  después: $after"
  fi
  ! port_busy "$E2E_PORT" || fail "el puerto $E2E_PORT sigue ocupado tras la limpieza"
  ! port_busy "$E2E_MQTT_PORT" || fail "el puerto $E2E_MQTT_PORT sigue ocupado tras la limpieza"
  ! port_busy "$E2E_EMQX_API_PORT" || fail "el puerto $E2E_EMQX_API_PORT sigue ocupado tras la limpieza"
  ! port_busy "$E2E_WSS_PORT" || fail "el puerto $E2E_WSS_PORT sigue ocupado tras la limpieza"
  ! docker inspect "$EMQX_NAME" >/dev/null 2>&1 || fail "el contenedor $EMQX_NAME sigue existiendo"
  [ "$(sql -c "select count(*) from public.tenants where name = 'E2E $ID'")" = 0 ] || fail "quedó el tenant E2E en la base local"
  [ "$(sql -c "select count(*) from public.panels where panel_code = '$PANEL_CODE'")" = 0 ] || fail "quedó el panel E2E en la base local"

  printf '\n[e2e] Resumen:%s\n\n' "$RESULTS"
}

main "$@"
echo "E2E OK"
