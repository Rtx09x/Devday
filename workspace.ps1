$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Activate-Workspace.ps1')
Push-Location (Join-Path $PSScriptRoot 'cutu-circuits')
try {
  & node (Join-Path $PSScriptRoot '.tools\package\bin\npm-cli.js') @args
  $result = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $result


