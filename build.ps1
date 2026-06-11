# build.ps1 — пакує збірки розширення в dist/:
#   • Firefox -> HighlightRows-Firefox-<версія>.xpi
#   • Chrome  -> HighlightRows-<версія>.zip
# Версія береться з manifest.json кожної збірки. Записи в архіві — з прямими
# слешами («/»), як вимагають Firefox/Chrome. Compress-Archive у Windows
# PowerShell 5.1 пише «\», тож пакуємо через System.IO.Compression вручну.
#
# Запуск з теки репозиторію:  powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

function Get-ManifestVersion($dir) {
    $manifest = Get-Content (Join-Path $dir 'manifest.json') -Raw | ConvertFrom-Json
    return $manifest.version
}

function New-Package($srcDir, $outFile) {
    if (Test-Path $outFile) { Remove-Item $outFile -Force }
    $zip = [System.IO.Compression.ZipFile]::Open($outFile, 'Create')
    try {
        $base = (Resolve-Path $srcDir).Path.TrimEnd('\') + '\'
        Get-ChildItem -Path $srcDir -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($base.Length).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, 'Optimal') | Out-Null
        }
    } finally {
        $zip.Dispose()
    }
    Write-Host ("  -> {0} ({1:N0} bytes)" -f (Split-Path $outFile -Leaf), (Get-Item $outFile).Length)
}

$firefoxDir = Join-Path $root 'HighlightRows-Firefox'
$chromeDir = Join-Path $root 'HighlightRows'

$firefoxVersion = Get-ManifestVersion $firefoxDir
$chromeVersion = Get-ManifestVersion $chromeDir

Write-Host "Packaging Firefox $firefoxVersion ..."
New-Package $firefoxDir (Join-Path $dist "HighlightRows-Firefox-$firefoxVersion.xpi")

Write-Host "Packaging Chrome $chromeVersion ..."
New-Package $chromeDir (Join-Path $dist "HighlightRows-$chromeVersion.zip")

Write-Host "Done -> $dist"
