#!/bin/bash
while true; do
    /opt/open5gs-lab/sync-ues.sh || true
    sleep 5
done
