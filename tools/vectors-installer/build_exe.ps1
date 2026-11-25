# Builds a single-file exe (no Python needed on the user's machine): dist\otzaria-vectors-installer.exe
# Build-only requirements: pip install pyinstaller zstandard cryptography
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
python -m unittest
if ($LASTEXITCODE -ne 0) { throw 'tests failed' }
python -m PyInstaller --onefile --windowed --clean --noconfirm --name 'otzaria-vectors-installer' vectors_installer.py
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
Write-Host 'Built: dist\otzaria-vectors-installer.exe'
