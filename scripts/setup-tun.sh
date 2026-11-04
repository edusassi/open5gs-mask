#!/bin/bash
# ogstun is the UPF tunnel. 10.45.0.1 is the core gateway; UEs receive 10.45.0.2, .3, ...
set -euo pipefail

sysctl -w net.ipv4.ip_forward=1 >/dev/null
sysctl -w net.ipv4.conf.all.rp_filter=0 >/dev/null || true
sysctl -w net.ipv4.conf.default.rp_filter=0 >/dev/null || true

if ! ip link show ogstun >/dev/null 2>&1; then
    ip tuntap add name ogstun mode tun
fi

if ! ip -4 addr show dev ogstun | grep -q '10\.45\.0\.1/16'; then
    ip addr add 10.45.0.1/16 dev ogstun
fi
if ! ip -6 addr show dev ogstun | grep -q '2001:db8:cafe::1'; then
    ip addr add 2001:db8:cafe::1/48 dev ogstun || true
fi

ip link set ogstun mtu 1400
ip link set ogstun up
sysctl -w net.ipv4.conf.ogstun.rp_filter=0 >/dev/null || true

iptables -t nat -C POSTROUTING -s 10.45.0.0/16 ! -o ogstun -j MASQUERADE 2>/dev/null \
    || iptables -t nat -A POSTROUTING -s 10.45.0.0/16 ! -o ogstun -j MASQUERADE
iptables -C INPUT -i ogstun -j ACCEPT 2>/dev/null || iptables -I INPUT -i ogstun -j ACCEPT
iptables -C FORWARD -i ogstun -j ACCEPT 2>/dev/null || iptables -I FORWARD -i ogstun -j ACCEPT
iptables -C FORWARD -o ogstun -j ACCEPT 2>/dev/null || iptables -I FORWARD -o ogstun -j ACCEPT
