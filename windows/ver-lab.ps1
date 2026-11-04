$ErrorActionPreference = 'Stop'
$distro = if ($env:OPEN5GS_WSL_DISTRO) { $env:OPEN5GS_WSL_DISTRO } else { 'Open5GS' }
wsl.exe -d $distro -u root -- bash -lc 'echo "--- core ---"; ip -4 addr show ogstun 2>/dev/null || echo "ogstun parado"; echo "--- UEs ---"; ip netns list 2>/dev/null || true; echo "--- ports ---"; ss -lnt | grep -E "9999|8080" || true'
exit $LASTEXITCODE
