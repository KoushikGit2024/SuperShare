param([string]$Python = "python")
$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $Repo
try {
    & $Python -c "import PyInstaller" 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller is not installed. Install project requirements and PyInstaller in your build environment first."
    }
    & $Python -c "import aiohttp, psutil, qrcode, cryptography" 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Project dependencies are missing. Run python -m pip install -r requirements.txt in the build environment." }
    & $Python -m PyInstaller --noconfirm --clean --name SuperShareHost --console --add-data "static;static" --hidden-import aiohttp --hidden-import qrcode.image.svg --collect-all qrcode --collect-all cryptography run.py
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller packaging failed with exit code $LASTEXITCODE" }
    Write-Host "Package created under dist\SuperShareHost. Runtime data is stored under %LOCALAPPDATA%\SuperShare."
} finally { Pop-Location }
