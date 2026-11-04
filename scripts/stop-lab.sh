#!/bin/bash
set -u
pkill -f '/opt/open5gs-lab/ue-watch.sh' >/dev/null 2>&1 || true
pkill -x nr-ue >/dev/null 2>&1 || true
pkill -x nr-gnb >/dev/null 2>&1 || true
sleep 1
shopt -s nullglob
for unit in /lib/systemd/system/open5gs-*.service /usr/lib/systemd/system/open5gs-*.service /etc/systemd/system/open5gs-*.service; do
    systemctl stop "$(basename "$unit")" >/dev/null 2>&1 || true
done
systemctl stop mongod >/dev/null 2>&1 || true
ip link del ogstun >/dev/null 2>&1 || true
echo "Lab parado."
