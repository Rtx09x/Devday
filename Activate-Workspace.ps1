# Dot-source this file: . .\Activate-Workspace.ps1
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $codexNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
    if (Test-Path (Join-Path $codexNode 'node.exe')) { $env:PATH = "$codexNode;$env:PATH" }
}
$env:PATH = "$(Join-Path $PSScriptRoot '.venv\Scripts');$(Join-Path $PSScriptRoot '.tools\bin');$env:PATH"
$env:VIRTUAL_ENV = Join-Path $PSScriptRoot '.venv'
