# אורז את התוסף: src/ -> otzaria-github-downloader.otzplugin
# הארכיון חייב להיות שטוח — manifest.json בשורש, לא בתוך תיקייה.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root   = $PSScriptRoot
$src    = Join-Path $root 'src'
$output = Join-Path $root 'otzaria-github-downloader.otzplugin'

if (-not (Test-Path (Join-Path $src 'manifest.json'))) {
  Write-Error "src/manifest.json not found"
  exit 1
}
if (Test-Path $output) { Remove-Item $output -Force }

$zip = [System.IO.Compression.ZipFile]::Open($output, 'Create')
try {
  Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
    # נתיבים בארכיון עם / ולא \ — כך אוצריא קוראת אותם בכל מערכת הפעלה
    $entry = $_.FullName.Substring($src.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entry, 'Optimal') | Out-Null
    Write-Host ("  + {0}" -f $entry)
  }
} finally {
  $zip.Dispose()
}

$size = (Get-Item $output).Length
Write-Host ("Built {0} ({1:N0} bytes)" -f (Split-Path $output -Leaf), $size)

