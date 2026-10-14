#!/usr/bin/env bash
# LadiesGo — gera TODOS os dados de Angola a partir de 1 ficheiro Geofabrik.
# Corre NO VPS (Ubuntu ARM, 12 GB RAM). Idempotente: salta passos já feitos.
# Tempo total estimado: 30-90 min (Angola é leve). Espaço: ver README §12.
#
# Uso:
#   chmod +x build-angola-data.sh
#   ./build-angola-data.sh            # faz download + OSRM + Photon + tiles
#   ./build-angola-data.sh --skip-tiles   # salta tiles (ex.: só routing+search)
set -euo pipefail

OSRM_IMG="osrm/osrm-backend:v5.27.1"
PHOTON_IMG="ghcr.io/komoot/photon:0.7.2"
TILEMAKER_IMG="ghcr.io/systemed/tilemaker:v2.4.0"
PBF_URL="https://download.geofabrik.de/africa/angola-latest.osm.pbf"
# ↑ CORREÇÃO: é ANGOLA (africa/angola-latest.osm.pbf). NÃO usar portugal-latest.osm.pbf.

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$ROOT/data/osrm" "$ROOT/data/photon" "$ROOT/data/tiles" "$ROOT/data/tilemaker" "$ROOT/backups" "$ROOT/certbot-www"

SKIP_TILES=0
[ "${1:-}" = "--skip-tiles" ] && SKIP_TILES=1

echo "== 0. pré-voo (disco/RAM/docker) =="
df -h "$ROOT" | tail -1
free -h
docker --version
docker compose version
# mínimo 15 GB livres (PBF + OSRM + Photon + mbtiles em simultâneo durante o build)
AVAIL_KB=$(df -k --output=avail "$ROOT" | tail -1)
[ "$AVAIL_KB" -lt 15728640 ] && { echo "ERRO: precisas de >=15GB livres." >&2; exit 1; }

echo "== 1. download Angola Geofabrik (+checksum) =="
cd "$ROOT/data/osrm"
if [ ! -f angola-latest.osm.pbf ]; then
  wget -c "$PBF_URL" -O angola-latest.osm.pbf
fi
wget -q -O angola-latest.osm.pbf.md5 "$PBF_URL.md5" || true
if [ -f angola-latest.osm.pbf.md5 ]; then
  md5sum -c angola-latest.osm.pbf.md5 || { echo "ERRO: checksum falhou, apaga e volta a sacar." >&2; exit 1; }
fi
ls -lh angola-latest.osm.pbf
cp -f angola-latest.osm.pbf "$ROOT/data/photon/" 2>/dev/null || true
cp -f angola-latest.osm.pbf "$ROOT/data/tiles/" 2>/dev/null || true

echo "== 2. OSRM (extract → partition → customize, perfil car, MLD) =="
# RAM pico ~6-8 GB; em Ampere 12 GB corre sem swap. ~10-25 min.
if [ ! -f angola-latest.osrm ]; then
  docker run --rm -v "$ROOT/data/osrm:/data" "$OSRM_IMG" \
    osrm-extract -p /opt/car.lua /data/angola-latest.osm.pbf
fi
if [ ! -f angola-latest.osrm.cells ]; then
  docker run --rm -v "$ROOT/data/osrm:/data" "$OSRM_IMG" \
    osrm-partition /data/angola-latest.osrm
fi
if [ ! -f angola-latest.osrm.mldgr ]; then
  docker run --rm -v "$ROOT/data/osrm:/data" "$OSRM_IMG" \
    osrm-customize /data/angola-latest.osrm
fi
ls -lh angola-latest.osrm*
# copia para o volume nomeado osrm-data (o serviço monta o volume, não o bind):
docker volume create ladiesgo-maps_osrm-data >/dev/null || true
docker run --rm -v "$ROOT/data/osrm:/src:ro" -v ladiesgo-maps_osrm-data:/dst \
  busybox:1.36.1 sh -c 'cp -f /src/angola-latest.osrm* /dst/ && ls -lh /dst'

echo "== 3. Photon (import Angola p/ OpenSearch) =="
# Precisa do opensearch a correr. Import ~10-20 min, heap 1g chega p/ Angola.
docker compose --project-directory "$ROOT" up -d opensearch
echo "a aguardar opensearch healthy (até 3 min)…"
for i in $(seq 1 36); do
  if curl -sf 'http://localhost:9200/_cluster/health?wait_for_status=yellow&timeout=5s' >/dev/null; then break; fi
  sleep 5
done
# Import directo do .pbf (Photon >=0.6, sem Nominatim). Línguas pt+en+fr p/ Luanda.
# Se a tua 0.7.x reclamar das flags, corre `docker run --rm $PHOTON_IMG -help` e ajusta.
if [ -z "$(ls -A "$ROOT/data/photon" 2>/dev/null | grep -v osm.pbf || true)" ] \
   && [ -z "$(docker volume inspect ladiesgo-maps_photon-data >/dev/null 2>&1 && docker run --rm -v ladiesgo-maps_photon-data:/d busybox:1.36.1 ls /d 2>/dev/null || true)" ]; then
  docker run --rm \
    --network ladiesgo-maps_ladiesgo-net \
    -v "$ROOT/data/photon:/data:ro" \
    -v ladiesgo-maps_photon-data:/photon/data \
    "$PHOTON_IMG" \
    -import -languages en,pt,fr -in /data/angola-latest.osm.pbf \
    -data-dir /photon/data -host opensearch -port 9200
fi
echo "Photon import terminado (verifica com: curl 'localhost:2322/api?q=Luanda&limit=1' após up)."

if [ "$SKIP_TILES" = "1" ]; then echo "== 4. tiles SKIPPED (--skip-tiles) =="; exit 0; fi

echo "== 4. tiles .mbtiles Angola (tilemaker z0-14, estilo OpenMapTiles) =="
cd "$ROOT/data/tilemaker"
[ -f config-openmaptiles.json ] || wget -q https://raw.githubusercontent.com/systemed/tilemaker/master/resources/config-openmaptiles.json -O config-openmaptiles.json
[ -f process-openmaptiles.lua ] || wget -q https://raw.githubusercontent.com/systemed/tilemaker/master/resources/process-openmaptiles.lua -O process-openmaptiles.lua
if [ ! -f "$ROOT/data/tiles/angola.mbtiles" ]; then
  docker run --rm -v "$ROOT/data:/data" "$TILEMAKER_IMG" \
    --input /data/tiles/angola-latest.osm.pbf \
    --output /data/tiles/angola.mbtiles \
    --config /data/tilemaker/config-openmaptiles.json \
    --process /data/tilemaker/process-openmaptiles.lua
fi
ls -lh "$ROOT/data/tiles/angola.mbtiles"

echo "== 5. config.json do tileserver-gl =="
cat > "$ROOT/data/tiles/config.json" <<'EOF'
{
  "options": { "paths": { "root": "/data", "fonts": "fonts", "styles": "styles", "mbtiles": "" } },
  "styles": {
    "positron": { "style": "styles/positron-gl-style/style.json", "tilejson": { "type": "overlay" } },
    "basic":    { "style": "styles/basic-gl-style/style.json",    "tilejson": { "type": "overlay" } }
  },
  "data": {
    "angola": { "mbtiles": "angola.mbtiles" }
  }
}
EOF
mkdir -p "$ROOT/data/tiles/styles"
[ -d "$ROOT/data/tiles/styles/positron-gl-style" ] || (cd "$ROOT/data/tiles/styles" && wget -q https://github.com/openmaptiles/positron-gl-style/archive/refs/heads/master.zip -O positron.zip && unzip -q -o positron.zip && mv positron-gl-style-master positron-gl-style || true)
# Ajusta o style.json p/ servir tiles LOCAIS: glyphs/sprites/tiles se existirem apontam p/ /tiles/…
echo "Edita $ROOT/data/tiles/styles/*/style.json: source URL → local mbtiles (ver README §6-D)."
echo
echo "== OK. Segue para: docker compose up -d  (README §7) =="
du -sh "$ROOT/data"/*
