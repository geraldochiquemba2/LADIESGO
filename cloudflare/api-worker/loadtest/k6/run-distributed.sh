#!/usr/bin/env bash
# LadiesGo distributed k6 runner.
#
# Splits a total load across N remote VMs (each with its own IP), copies the
# test folder to each, runs k6 in parallel, and pulls the summaries back.
#
# 1) Generate accounts once from your machine:
#      node loadtest/provision-accounts.mjs --drivers=5000 --pax=5000 \
#        --out=loadtest/k6/accounts.json --tag=v1 --online
# 2) Create loadtest/k6/hosts.txt with one host per line (user@ip):
#      root@1.2.3.4
#      root@1.2.3.5
#      ...
# 3) Run (simple ramp):
#      MODE=both TRIP_VUS_TOTAL=5000 WS_VUS_TOTAL=3000 \
#        bash loadtest/k6/run-distributed.sh
#
#    Full campaign (staged ramp; targets are PER VM, e.g. 5 VMs -> 1000/VM):
#      MODE=both TRIP_VUS_TOTAL=5000 WS_VUS_TOTAL=3000 \
#      TRIP_STAGES="30s:100,2m:500,3m:1000,4m:1000,2m:0" \
#      WS_STAGES="30s:100,2m:600,3m:600,2m:0" \
#        bash loadtest/k6/run-distributed.sh
#
# Env knobs: HOSTS, KEY, REMOTE_DIR, API, WS_BASE, MODE, TRIP_VUS_TOTAL,
#   WS_VUS_TOTAL, WS_POOL, RAMP_UP, HOLD, RAMP_DOWN, TRIP_STAGES, WS_STAGES,
#   MAX_FAIL_RATE, MAX_P95, MIN_WS_OK, RUN_ID.
# NOTE: TRIP_STAGES/WS_STAGES targets are VUs on EACH VM (set to total/VMS).
#
# Campaign presets (standard shape, per VM, 5 VMs; peak = 5x). ~11.5 min each:
#   peak  500 : TRIP_STAGES="30s:10,2m:50,3m:100,4m:100,2m:0"      -> ~37.5k trips
#   peak 1000 : TRIP_STAGES="30s:20,2m:100,3m:200,4m:200,2m:0"     -> ~75k trips
#   peak 2500 : TRIP_STAGES="30s:50,2m:250,3m:500,4m:500,2m:0"     -> ~187k trips
#   peak 5000 : TRIP_STAGES="30s:100,2m:500,3m:1000,4m:1000,2m:0"  -> ~375k trips
# (estimate: trips ~= peak * 75; peak rate ~= peak * 0.155 trips/s; cycle ~6.3s)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOSTS="${HOSTS:-$HERE/hosts.txt}"
KEY="${KEY:-}"
REMOTE_DIR="${REMOTE_DIR:-/root/ladiesgo-k6}"
API="${API:-https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1}"
WS_BASE="${WS_BASE:-}"
MODE="${MODE:-both}"
TRIP_VUS_TOTAL="${TRIP_VUS_TOTAL:-0}"
WS_VUS_TOTAL="${WS_VUS_TOTAL:-0}"
WS_POOL="${WS_POOL:-0}"
RAMP_UP="${RAMP_UP:-2m}"
HOLD="${HOLD:-5m}"
RAMP_DOWN="${RAMP_DOWN:-1m}"
# Campaign staged ramp (per VM). Leave empty to use the simple ramp above.
TRIP_STAGES="${TRIP_STAGES:-}"
WS_STAGES="${WS_STAGES:-}"
# GO/NO-GO gates
MAX_FAIL_RATE="${MAX_FAIL_RATE:-0.05}"
MAX_P95="${MAX_P95:-1500}"
MIN_WS_OK="${MIN_WS_OK:-0.99}"
RUN_ID="${RUN_ID:-$(date +%s)}"

[ -f "$HOSTS" ] || { echo "missing hosts file: $HOSTS"; exit 1; }
[ -f "$HERE/accounts.json" ] || { echo "missing $HERE/accounts.json (run provision-accounts.mjs)"; exit 1; }

SSH="ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30"
SCP="scp -o StrictHostKeyChecking=no"
[ -n "$KEY" ] && { SSH="$SSH -i $KEY"; SCP="$SCP -i $KEY"; }

mapfile -t HOSTARR < <(grep -v '^[[:space:]]*$' "$HOSTS" | grep -v '^#')
VMS="${#HOSTARR[@]}"
[ "$VMS" -gt 0 ] || { echo "no hosts in $HOSTS"; exit 1; }

per_vm() { echo $(( ($1 + VMS - 1) / VMS )); }   # ceil(total/VMS), 0 stays 0
TRIP_PER_VM=$(per_vm "$TRIP_VUS_TOTAL")
WS_PER_VM=$(per_vm "$WS_VUS_TOTAL")
echo "target: $API"
echo "VMs: $VMS  tripVUs/VM: $TRIP_PER_VM  wsVUs/VM: $WS_PER_VM  mode: $MODE  run: $RUN_ID"

echo "[1/3] provisioning each VM (install k6 + ulimit + copy test)..."
for i in "${!HOSTARR[@]}"; do
  h="${HOSTARR[$i]}"
  (
    $SSH "$h" "mkdir -p '$REMOTE_DIR' && if ! command -v k6 >/dev/null 2>&1; then curl -sL https://github.com/grafana/k6/releases/download/v2.3.0/k6-v2.3.0-linux-amd64.tar.gz -o /tmp/k6.tgz && tar -xzf /tmp/k6.tgz -C /tmp && { sudo cp /tmp/k6-v2.3.0-linux-amd64/k6 /usr/local/bin/ 2>/dev/null || cp /tmp/k6-v2.3.0-linux-amd64/k6 /usr/local/bin/; } || echo 'WARN: instala o k6 manualmente em $h'; fi"
    $SCP -q "$HERE/ladiesgo.js" "$h:$REMOTE_DIR/"
    $SCP "$HERE/accounts.json" "$h:$REMOTE_DIR/"
  ) &
done
wait
echo "[1/3] done"

echo "[2/3] launching k6 on all VMs in parallel..."
for i in "${!HOSTARR[@]}"; do
  h="${HOSTARR[$i]}"
  IDX_START=$(( i * TRIP_PER_VM ))
  (
    $SSH "$h" "cd '$REMOTE_DIR' && bash -lc 'ulimit -n 100000; \
      MODE=$MODE API='$API' WS_BASE='$WS_BASE' WS_POOL=$WS_POOL \
      TRIP_VUS=$TRIP_PER_VM WS_VUS=$WS_PER_VM IDX_START=$IDX_START \
      RAMP_UP=$RAMP_UP HOLD=$HOLD RAMP_DOWN=$RAMP_DOWN \
      TRIP_STAGES='$TRIP_STAGES' WS_STAGES='$WS_STAGES' \
      MAX_FAIL_RATE=$MAX_FAIL_RATE MAX_P95=$MAX_P95 MIN_WS_OK=$MIN_WS_OK \
      k6 run --quiet ladiesgo.js > run-$RUN_ID.log 2>&1; echo done'"
  ) &
  echo "  -> $h  (IDX_START=$IDX_START tripVUs=$TRIP_PER_VM wsVUs=$WS_PER_VM pid $!)"
done
wait
echo "[2/3] all VMs finished"

echo "[3/3] pulling summaries..."
mkdir -p "$HERE/results-$RUN_ID"
for i in "${!HOSTARR[@]}"; do
  h="${HOSTARR[$i]}"
  $SCP "$h:$REMOTE_DIR/summary-*.json" "$HERE/results-$RUN_ID/" 2>/dev/null || true
  $SCP "$h:$REMOTE_DIR/run-$RUN_ID.log" "$HERE/results-$RUN_ID/$(echo "$h" | tr '@.' '__').log" 2>/dev/null || true
done
echo "[3/3] results in $HERE/results-$RUN_ID/"
ls -la "$HERE/results-$RUN_ID/" || true
echo "Aggregate: grep the per-VM summaries, or pipe each summary JSON into your dashboard."
