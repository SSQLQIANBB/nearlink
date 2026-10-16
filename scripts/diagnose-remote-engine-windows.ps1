# Read-only diagnostics. Run while NearLink is open; no admin, Python or capture needed.
param(
    [string]$InstallDir,
    [ValidateRange(1,60)][int]$Samples = 1
)
$ErrorActionPreference = 'Stop'
if (!$InstallDir) {
    $paths = @(Get-Process -Name 'nearlink-desktop' -ErrorAction SilentlyContinue |
        ForEach-Object { $_.Path } | Where-Object { $_ } | Select-Object -Unique)
    if ($paths.Count -ne 1) { throw 'Open exactly one installed NearLink client, or pass -InstallDir.' }
    $InstallDir = Split-Path -Parent $paths[0]
}
$root = Join-Path $InstallDir 'remote-control-engine'
$manifestPath = Join-Path $root 'manifest.json'
if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'MANIFEST_MISSING: installed remote-control-engine/manifest.json not found.' }
# Do not follow linked resource roots.
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ROOT_REPARSE_POINT' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.format -ne 'todesk-engine-bundle-v1' -or $manifest.target -ne 'x86_64-pc-windows-msvc') { throw 'UNSUPPORTED_MANIFEST' }
$expected = @{'manifest.json' = $true}
$directories = @{}
foreach ($item in $manifest.files) {
    if (!$item.path -or $item.path -match '(^/|\\|:|(^|/)\.\.?(/|$))') { throw 'INVALID_MANIFEST_PATH' }
    $expected[$item.path] = $true
    $parent = Split-Path -Parent ($item.path -replace '/', '\')
    while ($parent) {
        $directories[($parent -replace '\\', '/')] = $true
        $parent = Split-Path -Parent $parent
    }
}
function Check-Directory([string]$Directory, [string]$Prefix) {
    foreach ($entry in Get-ChildItem -LiteralPath $Directory -Force) {
        $relative = if ($Prefix) { "$Prefix/$($entry.Name)" } else { $entry.Name }
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { "REPARSE_POINT $relative"; continue }
        if ($entry.PSIsContainer) {
            if (!$directories.ContainsKey($relative)) { "UNLISTED_DIRECTORY $relative" }
            Check-Directory $entry.FullName $relative
        } elseif (!$expected.ContainsKey($relative)) { "UNLISTED_FILE $relative" }
    }
}
for ($sample = 1; $sample -le $Samples; $sample++) {
    "SAMPLE $sample $(Get-Date -Format o)"
    $issues = @(Check-Directory $root '')
    foreach ($item in $manifest.files) {
        $stream = $null
        $hash = $null
        try {
            $file = Join-Path $root ($item.path -replace '/', '\')
            $metadata = Get-Item -LiteralPath $file -Force
            if ($metadata.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REPARSE_POINT' }
            # Match the native verifier's read-only sharing mode. Never unlock or alter files.
            $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            if ($stream.Length -ne $item.size) { $issues += "SIZE_MISMATCH $($item.path)"; continue }
            $hash = [Security.Cryptography.SHA256]::Create()
            $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
            if ($actual -ne $item.sha256) { $issues += "HASH_MISMATCH $($item.path)" }
        } catch {
            $cause = $_.Exception
            while ($cause.InnerException) { $cause = $cause.InnerException }
            $issues += "READ_FAILED $($item.path) WIN32=$($cause.HResult -band 65535) TYPE=$($cause.GetType().Name)"
        } finally {
            if ($hash) { $hash.Dispose() }
            if ($stream) { $stream.Dispose() }
        }
    }
    if ($issues.Count) { $issues } else { 'FILES_MATCH_ON_DISK_MANIFEST' }
    if ($sample -lt $Samples) { Start-Sleep -Seconds 1 }
}
'NOTE: This checks files against the installed manifest, not the manifest embedded in the exe. No files or permissions were changed.'
