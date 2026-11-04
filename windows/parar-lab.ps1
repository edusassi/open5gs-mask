$ErrorActionPreference = 'Stop'
$distro = if ($env:OPEN5GS_WSL_DISTRO) { $env:OPEN5GS_WSL_DISTRO } else { 'Open5GS' }
wsl.exe -d $distro -u root -- bash /opt/open5gs-lab/stop-lab.sh
exit $LASTEXITCODE
