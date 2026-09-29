# Builds the .zip to upload to the Chrome Web Store.
# Run from this folder in PowerShell:   powershell -ExecutionPolicy Bypass -File .\package.ps1
# Only the files the extension needs go in the zip (no project notes, store text, devtools/
# test pages, or git data).

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$version = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$zipPath = Join-Path $PSScriptRoot "kayt-$version.zip"

$include = @(
    "manifest.json",
    "background.js",
    "privacy.html",
    "content",
    "sidepanel",
    "manage",
    "offscreen",
    "permission",
    "lib",
    "icons",
    "fonts"
)

if (Test-Path $zipPath) { Remove-Item $zipPath }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, "Create")
try {
    foreach ($item in $include) {
        $files = Get-ChildItem -Path $item -Recurse -File
        foreach ($file in $files) {
            # The Web Store needs forward slashes inside the zip.
            $entryName = $file.FullName.Substring($PSScriptRoot.Length + 1).Replace("\", "/")
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entryName) | Out-Null
        }
    }
}
finally {
    $zip.Dispose()
}

Write-Host "Created $zipPath"
