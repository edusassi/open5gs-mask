#!/bin/bash
set -euo pipefail
LAB=/opt/open5gs-lab
mkdir -p /var/log/open5gs-lab /run/open5gs-lab

bash "$LAB/setup-tun.sh"
systemctl start mongod
sleep 1

shopt -s nullglob
for unit in /lib/systemd/system/open5gs-*.service /usr/lib/systemd/system/open5gs-*.service /etc/systemd/system/open5gs-*.service; do
    systemctl start "$(basename "$unit")" || echo "Falha ao iniciar $(basename "$unit")"
done

echo "Esperando o AMF em 127.0.0.5:38412 (SCTP)"
ok=0
for _ in $(seq 1 45); do
    if ss --sctp -ln 2>/dev/null | grep -q ':38412' || grep -q ':38412' /proc/net/sctp/eps 2>/dev/null; then
        ok=1
        break
    fi
    sleep 1
done
if [ "$ok" != 1 ]; then
    echo "O AMF nao abriu a porta SCTP 38412."
    echo "Se /proc/net/sctp nao existir, o kernel do WSL esta sem SCTP."
    ls /proc/net/sctp 2>/dev/null || echo "SCTP ausente no kernel"
    tail -n 40 /var/log/open5gs/amf.log 2>/dev/null || true
    exit 1
fi

if ! pgrep -x nr-gnb >/dev/null; then
    : > /var/log/open5gs-lab/gnb.log
    nohup /opt/UERANSIM/build/nr-gnb -c "$LAB/gnb.yaml" >> /var/log/open5gs-lab/gnb.log 2>&1 &
fi

echo "Esperando o gNB registrar no AMF"
ok=0
for _ in $(seq 1 30); do
    if grep -qi "NG Setup procedure is successful" /var/log/open5gs-lab/gnb.log; then
        ok=1
        break
    fi
    sleep 1
done
if [ "$ok" != 1 ]; then
    echo "O gNB nao completou o NG Setup."
    tail -n 50 /var/log/open5gs-lab/gnb.log || true
    exit 1
fi

if ! pgrep -f '/opt/open5gs-lab/ue-watch.sh' >/dev/null; then
    nohup /opt/open5gs-lab/ue-watch.sh >> /var/log/open5gs-lab/ue-watch.log 2>&1 &
fi

bash "$LAB/sync-ues.sh"

echo "Esperando o endereco 10.45.0.x na interface do UE"
for _ in $(seq 1 40); do
    if ip -4 -o addr show | grep -q 'uesimtun'; then
        break
    fi
    sleep 1
done

echo
echo "======== Open5GS + UERANSIM ========"
echo "Gateway do core (ogstun):"
ip -4 addr show ogstun | sed -n 's/^[[:space:]]*inet /  /p'
echo "UEs virtuais:"
found=0
if ip -4 -o addr show | grep -q uesimtun; then
    ip -4 -o addr show | awk '/uesimtun/ {print "  "$2"  "$4}'
    found=1
fi
for ns in $(ip netns list 2>/dev/null | awk '{print $1}'); do
    line=$(ip netns exec "$ns" ip -4 -o addr show 2>/dev/null | awk -v ns="$ns" '/uesimtun/ {print "  "ns"  "$2"  "$4}')
    if [ -n "$line" ]; then
        printf '%s\n' "$line"
        found=1
    fi
done
if [ "$found" != 1 ]; then
    echo "  nenhum endereco ainda. Veja /var/log/open5gs-lab/ue-*.log"
fi
echo
echo "WebUI dos SIM cards: http://localhost:9999"
echo "Usuario: admin    Senha inicial: 1423"
echo "Ao salvar um SIM novo, o UE correspondente sobe sozinho e recebe o proximo IP (10.45.0.2, .3, .4...)."
echo "===================================="
