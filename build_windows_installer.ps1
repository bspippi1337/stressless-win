# Installer build (Windows) using Chocolatey + Inno Setup
$ErrorActionPreference = "Stop"

if (-not (Get-Command choco -ErrorAction SilentlyContinue)) { throw "Chocolatey (choco) not found." }

# deps
if (-not (Get-Command go -ErrorAction SilentlyContinue)) { choco install golang -y }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { choco install dotnet-8.0-sdk -y }
if (-not (Get-Command ISCC.exe -ErrorAction SilentlyContinue)) { choco install innosetup -y }

# build portable stage first
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_windows_portable.ps1

# build installer
ISCC.exe installer\Stressless.iss
Write-Host "INSTALLER READY: dist\windows\StresslessSetup.exe"
