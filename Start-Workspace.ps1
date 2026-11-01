param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$keyFile = Join-Path $PSScriptRoot '.env.local'
$allowedKeys = @('CEREBRAS_API_KEY', 'EXA_API_KEY')
$previousValues = @{}
foreach ($keyName in $allowedKeys) { $previousValues[$keyName] = [Environment]::GetEnvironmentVariable($keyName, 'Process') }
Push-Location $PSScriptRoot
try {
    . .\Activate-Workspace.ps1
    if (Test-Path -LiteralPath $keyFile) {
        # Parse assignments as data; never execute/source the credentials file.
        foreach ($credentialLine in [System.IO.File]::ReadAllLines($keyFile)) {
            if (-not $credentialLine.Trim() -or $credentialLine.TrimStart().StartsWith('#')) { continue }
            if ($credentialLine -notmatch '^\s*(CEREBRAS_API_KEY|EXA_API_KEY)\s*=\s*(.*?)\s*$') { throw 'Invalid .env.local assignment. Only the two provider keys are supported.' }
            $keyName = $Matches[1]
            $keyValue = $Matches[2]
            if (($keyValue.StartsWith('"') -and $keyValue.EndsWith('"')) -or ($keyValue.StartsWith("'") -and $keyValue.EndsWith("'"))) { $keyValue = $keyValue.Substring(1, $keyValue.Length - 2) }
            [Environment]::SetEnvironmentVariable($keyName, $keyValue, 'Process')
        }
    }
    foreach ($keyName in $allowedKeys) {
        $isConfigured = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($keyName, 'Process'))
        Write-Host "$keyName configured: $isConfigured"
    }
    # Do not attach to an older process which cannot inherit these credentials.
    try { $listener = Get-NetTCPConnection -LocalPort 4310 -State Listen -ErrorAction Stop } catch { $listener = $null }
    if ($listener) { throw 'Port 4310 is already in use. Stop the existing workspace, then rerun this launcher so it receives the provider keys.' }
    Push-Location cutu-circuits
    try {
        $demoArguments = @('scripts/start-demo.mjs')
        if ($SkipBuild) { $demoArguments += '--skip-build' }
        & node @demoArguments
        if ($LASTEXITCODE -ne 0) { throw 'Workspace exited with an error.' }
    } finally { Pop-Location }
} finally {
    foreach ($keyName in $allowedKeys) { [Environment]::SetEnvironmentVariable($keyName, $previousValues[$keyName], 'Process') }
    Pop-Location
}
