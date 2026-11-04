#!/bin/bash
# Copy helper scripts and example configs into /opt/open5gs-lab
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root (sudo)."
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAB="${OPEN5GS_LAB_DIR:-/opt/open5gs-lab}"
mkdir -p "$LAB" /var/log/open5gs-lab
for f in setup-tun.sh start-lab.sh stop-lab.sh sync-ues.sh ue-watch.sh prep-manual.sh; do
  install -m 755 "$ROOT/scripts/$f" "$LAB/$f"
done
cp "$ROOT/configs/open5gs-gnb.yaml" "$LAB/manual-gnb.yaml"
cp "$ROOT/configs/open5gs-ue-1.yaml" "$LAB/manual-ue.yaml"
cp "$ROOT/configs/open5gs-ue-2.yaml" "$LAB/manual-ue-2.yaml"
cp "$ROOT/configs/open5gs-ue-3.yaml" "$LAB/manual-ue-3.yaml"
cp "$ROOT/configs/open5gs-gnb.yaml" "$LAB/gnb.yaml"
echo "Helpers instalados em $LAB"
