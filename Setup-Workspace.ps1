$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Push-Location $PSScriptRoot
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        $codexNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
        if (Test-Path (Join-Path $codexNode 'node.exe')) { $env:PATH = "$codexNode;$env:PATH" }
    }
    & node -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1)"
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 24 or newer is required.' }
    if (-not (Test-Path '.tools\package\bin\npm-cli.js')) {
        New-Item -ItemType Directory -Force .tools | Out-Null
        Invoke-WebRequest 'https://registry.npmjs.org/npm/-/npm-11.6.2.tgz' -OutFile '.tools\npm.tgz'
        tar -xzf .tools\npm.tgz -C .tools
        if ($LASTEXITCODE -ne 0) { throw 'Could not extract npm.' }
    }
    New-Item -ItemType Directory -Force .tools\bin | Out-Null
    '@echo off', 'node "%~dp0..\package\bin\npm-cli.js" %*' | Set-Content .tools\bin\npm.cmd
    if (-not (Test-Path '.venv\Scripts\python.exe')) {
        $python = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
        if (-not (Test-Path $python)) {
            winget install --id Python.Python.3.12 --exact --source winget --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
            if ($LASTEXITCODE -ne 0) { throw 'Python installation failed.' }
        }
        & $python -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python virtual environment.' }
    }
    # Provide the executable name used by the portable example manifests.
    Copy-Item .venv\Scripts\python.exe .venv\Scripts\python3.exe -Force
    . .\Activate-Workspace.ps1
    python -m pip install -r cutu-circuits\requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
    python -m pip check
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency check failed.' }
    foreach ($providerPackage in @('Cerebras', 'Exa')) {
        Push-Location $providerPackage
        try {
            npm ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "$providerPackage dependency installation failed." }
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "$providerPackage build failed." }
        } finally { Pop-Location }
    }
    Push-Location cutu-circuits
    try {
        npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm dependency installation failed.' }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
        node node_modules\playwright\cli.js install chromium
        if ($LASTEXITCODE -ne 0) { throw 'Browser installation failed.' }
    } finally { Pop-Location }
    Write-Host 'Workspace dependencies are ready. Run .\workspace.ps1 run dev'
} finally { Pop-Location }
