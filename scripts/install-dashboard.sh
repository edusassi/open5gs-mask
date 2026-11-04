#!/bin/bash
# Install Open5GS Mask dashboard next to an existing Open5GS + UERANSIM lab.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root (sudo)."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/dashboard"
DST="${OPEN5GS_MASK_DIR:-/opt/open5gs-mask-dashboard}"
LAB="${OPEN5GS_LAB_DIR:-/opt/open5gs-lab}"
UERANSIM_DIR="${UERANSIM_DIR:-/opt/UERANSIM}"
PORT="${PORT:-8080}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js não encontrado. Instale Node 18+ e rode de novo."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm não encontrado."
  exit 1
fi

echo "==> Instalando dashboard em $DST"
mkdir -p "$DST" "$LAB" /var/log/open5gs-lab
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules "$SRC/" "$DST/"
else
  rm -rf "${DST:?}/"*
  cp -a "$SRC"/. "$DST"/
  rm -rf "$DST/node_modules"
fi

cd "$DST"
npm install --omit=dev

# Lab helper scripts
for f in setup-tun.sh start-lab.sh stop-lab.sh sync-ues.sh ue-watch.sh prep-manual.sh; do
  if [ -f "$ROOT/scripts/$f" ]; then
    install -m 755 "$ROOT/scripts/$f" "$LAB/$f"
  fi
done

# Seed UERANSIM configs for the dashboard actions
if [ -d "$UERANSIM_DIR/config" ]; then
  cp -n "$ROOT/configs/open5gs-gnb.yaml" "$LAB/manual-gnb.yaml" 2>/dev/null || \
    cp "$ROOT/configs/open5gs-gnb.yaml" "$LAB/manual-gnb.yaml"
  cp -n "$ROOT/configs/open5gs-ue-1.yaml" "$LAB/manual-ue.yaml" 2>/dev/null || \
    cp "$ROOT/configs/open5gs-ue-1.yaml" "$LAB/manual-ue.yaml"
  cp -n "$ROOT/configs/open5gs-ue-2.yaml" "$LAB/manual-ue-2.yaml" 2>/dev/null || true
  cp -n "$ROOT/configs/open5gs-ue-3.yaml" "$LAB/manual-ue-3.yaml" 2>/dev/null || true
  cp -n "$ROOT/configs/open5gs-gnb.yaml" "$LAB/gnb.yaml" 2>/dev/null || true
else
  echo "Aviso: UERANSIM não encontrado em $UERANSIM_DIR (ok se for só dashboard)."
  cp "$ROOT/configs/open5gs-gnb.yaml" "$LAB/manual-gnb.yaml"
  cp "$ROOT/configs/open5gs-ue-1.yaml" "$LAB/manual-ue.yaml"
fi

cat > /etc/systemd/system/open5gs-mask-dashboard.service << EOF
[Unit]
Description=Open5GS Mask Lab Dashboard
After=network.target mongod.service
Wants=mongod.service

[Service]
Type=simple
WorkingDirectory=$DST
Environment=NODE_ENV=production
Environment=HOSTNAME=0.0.0.0
Environment=PORT=$PORT
Environment=GNB_CFG=$LAB/manual-gnb.yaml
Environment=UE_CFG=$LAB/manual-ue.yaml
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable open5gs-mask-dashboard
systemctl restart open5gs-mask-dashboard

echo
echo "Dashboard:  http://localhost:$PORT"
echo "WebUI SIMs: http://localhost:9999   (admin / 1423 se for a WebUI padrão do Open5GS)"
echo
systemctl --no-pager --full status open5gs-mask-dashboard | head -15
