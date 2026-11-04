#!/bin/bash
# One virtual UE per SIM registered in the Open5GS database.
set -u
LAB=/opt/open5gs-lab
UE_DIR="$LAB/ues"
BIN=/opt/UERANSIM/build/nr-ue
TEMPLATE=/opt/UERANSIM/config/open5gs-ue.yaml
mkdir -p "$UE_DIR" /var/log/open5gs-lab /run/open5gs-lab

exec 9>/run/open5gs-lab/sync.lock
flock -w 60 9 || exit 1

if ! pgrep -x nr-gnb >/dev/null; then
    exit 0
fi

ROWS=$(mongosh --quiet --norc open5gs --eval '
db.subscribers.find({}, {imsi:1, security:1, slice:1}).forEach(function(s) {
  if (!s.imsi || !s.security || !s.security.k) return;
  var opc = (s.security.opc || "").toString();
  var op = (s.security.op || "").toString();
  var code = opc.length ? opc : op;
  var typ = opc.length ? "OPC" : "OP";
  var amf = (s.security.amf || "8000").toString();
  var dnn = "internet";
  if (s.slice && s.slice.length && s.slice[0].session && s.slice[0].session.length && s.slice[0].session[0].name) {
    dnn = s.slice[0].session[0].name;
  }
  if (!code.length) return;
  print(s.imsi + "\t" + s.security.k + "\t" + code + "\t" + typ + "\t" + amf + "\t" + dnn);
});
')

declare -A WANT=()
while IFS=$'\t' read -r imsi key code typ amf dnn; do
    [ -z "${imsi:-}" ] && continue
    [[ "$imsi" =~ ^[0-9]{15}$ ]] || continue
    WANT["$imsi"]=1
    cfg="$UE_DIR/${imsi}.yaml"
    python3 - "$TEMPLATE" "$cfg" "$imsi" "$key" "$code" "$typ" "$amf" "$dnn" <<'PY'
import sys
src, dst, imsi, key, code, typ, amf, dnn = sys.argv[1:]
out = []
for line in open(src, encoding="utf-8"):
    raw = line.rstrip("\n")
    stripped = raw.strip()
    indent = raw[:len(raw) - len(raw.lstrip(" "))]
    if stripped.startswith("supi:"):
        out.append(f"supi: 'imsi-{imsi}'")
    elif stripped.startswith("key:"):
        out.append(f"key: '{key}'")
    elif stripped.startswith("op:"):
        out.append(f"op: '{code}'")
    elif stripped.startswith("opType:"):
        out.append(f"opType: '{typ}'")
    elif stripped.startswith("amf:"):
        out.append(f"amf: '{amf}'")
    elif stripped.startswith("imei:"):
        out.append(f"imei: '3569380{imsi[-8:]}'")
    elif stripped == "sd: 1":
        continue
    elif stripped.startswith("apn:"):
        out.append(f"{indent}apn: '{dnn}'")
    elif stripped.startswith("useNamespace:"):
        out.append("useNamespace: true")
    else:
        out.append(raw)
open(dst, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
PY
    if pgrep -f "nr-ue -c ${cfg}" >/dev/null; then
        continue
    fi
    echo "Subindo UE IMSI ${imsi}"
    nohup "$BIN" -c "$cfg" >> "/var/log/open5gs-lab/ue-${imsi}.log" 2>&1 &
    sleep 3
done <<< "$ROWS"

shopt -s nullglob
for cfg in "$UE_DIR"/*.yaml; do
    imsi=$(basename "$cfg" .yaml)
    if [ -z "${WANT[$imsi]:-}" ]; then
        pkill -f "nr-ue -c ${cfg}" >/dev/null 2>&1 || true
        rm -f "$cfg"
        echo "UE IMSI ${imsi} removido"
    fi
done
