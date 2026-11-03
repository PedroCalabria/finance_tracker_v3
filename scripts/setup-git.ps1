# Cria o repositório git nesta pasta a partir do histórico entregue em
# financas.bundle (o Claude não consegue gravar a pasta .git diretamente).
# Rode uma vez, no PowerShell, dentro da pasta finance_tracker_v3:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-git.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if (Test-Path .git) { Write-Host 'Já existe um repositório git aqui. Nada a fazer.'; exit 0 }
if (-not (Test-Path financas.bundle)) { throw 'Arquivo financas.bundle não encontrado nesta pasta.' }

git init -b main
git config core.autocrlf false
git fetch financas.bundle main:refs/remotes/bundle/main
# Os arquivos da pasta já são os do último commit: só aponta o histórico para eles.
git reset --mixed bundle/main
git update-ref -d refs/remotes/bundle/main
git status --short | Select-Object -First 10
Write-Host ''
git log --oneline -n 12
Write-Host ''
Write-Host 'Pronto. Pode apagar financas.bundle (ou guardar como cópia).'
