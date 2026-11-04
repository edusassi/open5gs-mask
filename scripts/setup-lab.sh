#!/bin/bash
# Optional full bootstrap on Ubuntu: MongoDB + Open5GS + Node + dashboard helpers.
# Prefer following the official Open5GS quickstart if you already have a lab.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root (sudo)."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Pacotes base ==="
apt-get update
apt-get install -y ca-certificates curl gnupg software-properties-common \
  iproute2 iptables iputils-ping make gcc g++ cmake git python3 \
  libsctp-dev lksctp-tools

echo "=== MongoDB 8 ==="
if ! command -v mongod >/dev/null 2>&1; then
  curl -fsSL https://pgp.mongodb.com/server-8.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg
  . /etc/os-release
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${VERSION_CODENAME}/mongodb-org/8.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-8.0.list
  apt-get update || {
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/8.0 multiverse" \
      > /etc/apt/sources.list.d/mongodb-org-8.0.list
    apt-get update
  }
  apt-get install -y mongodb-org
fi
systemctl enable --now mongod

echo "=== Open5GS ==="
if ! dpkg -s open5gs >/dev/null 2>&1; then
  add-apt-repository -y ppa:open5gs/latest
  apt-get update
  apt-get install -y open5gs
fi

echo "=== Node.js 20 ==="
if ! command -v node >/dev/null 2>&1; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi

echo "=== WebUI Open5GS ==="
if [ ! -f /lib/systemd/system/open5gs-webui.service ] && [ ! -f /usr/lib/systemd/system/open5gs-webui.service ]; then
  mkdir -p /tmp/open5gs-webui-src
  ( cd /tmp/open5gs-webui-src && curl -fsSL https://open5gs.org/open5gs/assets/webui/install | bash - )
fi

echo "=== UERANSIM ==="
if [ ! -x /opt/UERANSIM/build/nr-gnb ]; then
  rm -rf /opt/UERANSIM
  git clone --depth 1 https://github.com/aligungr/UERANSIM.git /opt/UERANSIM
  make -C /opt/UERANSIM -j"$(nproc)"
fi

echo "=== Open5GS Mask ==="
bash "$ROOT/scripts/install-dashboard.sh"
bash "$ROOT/scripts/install-lab-helpers.sh"
mongosh --quiet --norc open5gs "$ROOT/scripts/seed-demo-sims.js" || true
bash /opt/open5gs-lab/setup-tun.sh || true

echo
echo "Bootstrap concluído."
echo "Dashboard: http://localhost:8080"
echo "WebUI SIMs: http://localhost:9999 (admin / 1423)"
