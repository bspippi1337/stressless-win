# Portable build (Windows) - self-healing paths
# Requirements: choco (will be used to install Go/.NET if missing)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Step($m){ Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m){ Write-Host "✔ $m" -ForegroundColor Green }

# Always run from repo root, regardless of caller cwd
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

if (-not (Get-Command choco -ErrorAction SilentlyContinue)) { throw "Chocolatey (choco) not found." }

if (-not (Get-Command go -ErrorAction SilentlyContinue)) { Step "Installing Go"; choco install golang -y --no-progress | Out-Host }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { Step "Installing .NET SDK"; choco install dotnet-8.0-sdk -y --no-progress | Out-Host }

Step "[1/3] Build backend exe"
$ServerDir = Join-Path $RepoRoot "apps\server-go"
if (-not (Test-Path $ServerDir)) { throw "Missing folder: $ServerDir" }
Push-Location $ServerDir
New-Item -ItemType Directory -Force "bin" | Out-Null
go build -o "bin\stressless-server.exe" ".\cmd\server"
Pop-Location
Ok "Backend built"

Step "[2/3] Publish WPF"
$WpfProj = Join-Path $RepoRoot "apps\windows-wpf\Stressless.Wpf\Stressless.Wpf.csproj"
if (-not (Test-Path $WpfProj)) { throw "Missing project: $WpfProj" }
dotnet publish $WpfProj -c Release -r win-x64 --self-contained false
Ok "WPF published"

Step "[3/3] Stage portable folder"
$pub = Join-Path $RepoRoot "apps\windows-wpf\Stressless.Wpf\bin\Release\net8.0-windows\win-x64\publish"
if (-not (Test-Path $pub)) { throw "Publish output not found: $pub" }

$dst = Join-Path $RepoRoot "dist\portable\stressless"
Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item -Recurse -Force (Join-Path $pub "*") $dst

New-Item -ItemType Directory -Force (Join-Path $dst "bin") | Out-Null
Copy-Item -Force (Join-Path $RepoRoot "apps\server-go\bin\stressless-server.exe") (Join-Path $dst "bin\stressless-server.exe")

Ok "PORTABLE READY: $dst"

# Auto-sign if certificate present and signtool is available
$exe = Join-Path $dst "Stressless.Wpf.exe"
if (Test-Path (Join-Path $RepoRoot "stressless_codesign.pfx") -and (Get-Command signtool -ErrorAction SilentlyContinue) -and (Test-Path $exe)) {
  Step "Signing portable EXE"
  signtool sign /fd SHA256 /f (Join-Path $RepoRoot "stressless_codesign.pfx") /p stressless $exe | Out-Host
  signtool verify /pa $exe | Out-Host
  Ok "Signed + verified"
} else {
  Step "Signing skipped (no PFX and/or signtool)"
}
