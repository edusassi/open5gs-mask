# Windows + WSL2 (opcional)

O UERANSIM **não roda no Windows nativo** (falta SCTP). Em um PC Windows, use **WSL2 com Ubuntu** ou uma VM Linux.

## Requisitos

- Windows 10/11 com virtualização habilitada
- WSL2 + Ubuntu 22.04/24.04
- systemd habilitado (`/etc/wsl.conf` com `systemd=true`)
- Módulos `sctp` e `tun` carregados

## Fluxo sugerido

1. Instale Open5GS, MongoDB e WebUI dentro do Ubuntu (WSL), seguindo o [Quickstart do Open5GS](https://open5gs.org/open5gs/docs/guide/01-quickstart/).
2. Compile o [UERANSIM](https://github.com/aligungr/UERANSIM) em `/opt/UERANSIM`.
3. Clone este repositório e rode:

```bash
sudo bash scripts/install-dashboard.sh
sudo bash scripts/install-lab-helpers.sh
```

4. No Windows, a porta `8080` (dashboard) e `9999` (WebUI) são acessíveis via `localhost` com o encaminhamento padrão do WSL2.

## Laboratório remoto

Se o Open5GS já está em um servidor Linux, o Windows não precisa do WSL. Abra só o túnel e use o navegador:

```powershell
ssh -L 8080:127.0.0.1:8080 -L 9999:127.0.0.1:9999 usuario@servidor-do-core
```

http://localhost:8080 é o Mask. http://localhost:9999 é a WebUI oficial dos SIMs.

Scripts auxiliares em `windows/`:

- `iniciar-lab.ps1` / `parar-lab.ps1` / `ver-lab.ps1`

Defina `OPEN5GS_WSL_DISTRO` se a distro não se chamar `Open5GS`.
