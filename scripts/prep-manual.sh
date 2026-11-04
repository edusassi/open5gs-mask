#!/bin/bash
set -u
pkill -f '/opt/open5gs-lab/ue-watch.sh' >/dev/null 2>&1 || true
pkill -x nr-ue >/dev/null 2>&1 || true
pkill -x nr-gnb >/dev/null 2>&1 || true
sleep 1

# Keep Open5GS core running
systemctl start mongod open5gs-nrfd open5gs-scpd open5gs-amfd open5gs-smfd open5gs-upfd \
  open5gs-ausfd open5gs-udmd open5gs-udrd open5gs-pcfd open5gs-nssfd open5gs-bsfd open5gs-webui 2>/dev/null || true
bash /opt/open5gs-lab/setup-tun.sh

# Manual UE config: same SIM as WebUI, with namespace so ping works on one machine
mkdir -p /opt/open5gs-lab
cp /opt/UERANSIM/config/open5gs-gnb.yaml /opt/open5gs-lab/manual-gnb.yaml
cp /opt/UERANSIM/config/open5gs-ue.yaml /opt/open5gs-lab/manual-ue.yaml
sed -i 's/^useNamespace:.*/useNamespace: true/' /opt/open5gs-lab/manual-ue.yaml

echo "=== Core ==="
systemctl is-active open5gs-amfd open5gs-smfd open5gs-upfd mongod
echo "=== ogstun ==="
ip -4 addr show ogstun | sed -n 's/^[[:space:]]*inet /  /p'
echo "=== gNB config ==="
echo "  /opt/open5gs-lab/manual-gnb.yaml"
echo "=== UE config ==="
echo "  /opt/open5gs-lab/manual-ue.yaml"
echo "=== bins ==="
ls /opt/UERANSIM/build/nr-gnb /opt/UERANSIM/build/nr-ue
echo "Pronto: core ligado, gNB/UE parados. Suba voce nos terminais."
