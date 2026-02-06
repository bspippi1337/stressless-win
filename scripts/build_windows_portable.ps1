# Portable build (Windows) using Chocolatey
# Requirements: choco
$ErrorActionPreference = "Stop"

if (-not (Get-Command choco -ErrorAction SilentlyContinue)) { throw "Chocolatey (choco) not found." }

if (-not (Get-Command go -ErrorAction SilentlyContinue)) { choco install golang -y }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { choco install dotnet-8.0-sdk -y }

Write-Host "[1/3] Build backend exe"
Push-Location "apps\server-go"
go build -o "bin\stressless-server.exe" ".\cmd\server"
Pop-Location

Write-Host "[2/3] Publish WPF"
dotnet publish "apps\windows-wpf\Stressless.Wpf\Stressless.Wpf.csproj" -c Release -r win-x64 --self-contained false

Write-Host "[3/3] Stage portable folder"
$pub = "apps\windows-wpf\Stressless.Wpf\bin\Release\net8.0-windows\win-x64\publish"
$dst = "dist\portable\Stressless"
Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item -Recurse -Force "$pub\*" $dst
New-Item -ItemType Directory -Force "$dst\bin" | Out-Null
Copy-Item -Force "apps\server-go\bin\stressless-server.exe" "$dst\bin\stressless-server.exe"

Write-Host "PORTABLE READY: $dst"


# Auto-sign if certificate present
if (Test-Path '.\stressless_codesign.pfx') {
  Write-Host 'Signing binary...'
  signtool sign /fd SHA256 /f stressless_codesign.pfx /p stressless dist\portable\stressless\Stressless.Wpf.exe
}
