#Requires -Version 5.1
<#
.SYNOPSIS
    One-time setup for the CTC Gaussian Splatting processing workstation.
    Installs COLMAP, ffmpeg, Miniconda, nerfstudio (splatfacto), and Node.js.
    Run from an elevated PowerShell prompt (right-click → Run as Administrator).
#>

Set-StrictMode -Version Latest

# ── Helpers ───────────────────────────────────────────────────────────────────

function Write-Step { param($msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok   { param($msg) Write-Host "    OK   $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "    WARN $msg" -ForegroundColor Yellow }
function Write-Fail {
    param($msg)
    Write-Host "`n    FAIL $msg" -ForegroundColor Red
    exit 1
}

function Update-SessionPath {
    $machine = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    $user    = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $env:PATH = "$machine;$user"
}

function Find-Conda {
    $cmd = Get-Command conda -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "$env:USERPROFILE\miniconda3\Scripts\conda.exe",
        "$env:LOCALAPPDATA\miniconda3\Scripts\conda.exe",
        "$env:USERPROFILE\Miniconda3\Scripts\conda.exe",
        "$env:PROGRAMDATA\miniconda3\Scripts\conda.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return $null
}

# ── Preflight checks ──────────────────────────────────────────────────────────

Write-Step "Preflight checks"

if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Fail "PowerShell 5.1 or later required. Current: $($PSVersionTable.PSVersion)"
}
Write-Ok "PowerShell $($PSVersionTable.PSVersion)"

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Fail "winget not found. Install 'App Installer' from the Microsoft Store, then re-run this script."
}
Write-Ok "winget available"

$nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $nvidiaSmi) {
    Write-Fail "nvidia-smi not found. Install the NVIDIA driver from nvidia.com/drivers, then re-run this script."
}
$gpuInfo = (nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits 2>&1) -join ""
if ($LASTEXITCODE -ne 0) {
    Write-Fail "nvidia-smi returned an error. Ensure the NVIDIA driver is installed and working."
}
Write-Ok "GPU detected: $gpuInfo"

$freeGB = [math]::Round((Get-PSDrive C).Free / 1GB, 1)
if ($freeGB -lt 20) {
    Write-Warn "Only ${freeGB} GB free on C:\. 20 GB+ recommended. Continuing anyway."
} else {
    Write-Ok "${freeGB} GB free on C:\"
}

# ── winget packages ───────────────────────────────────────────────────────────

Write-Step "Installing base packages via winget"

# Exit code -1978335189 (0x8A150021) = WINGET_INSTALLED_STATUS_ALREADY_INSTALLED — treat as success
$packages = @(
    @{ Id = "Git.Git";             Label = "Git" },
    @{ Id = "Gyan.FFmpeg";         Label = "ffmpeg" },
    @{ Id = "OpenJS.NodeJS.LTS";   Label = "Node.js LTS" },
    @{ Id = "Anaconda.Miniconda3"; Label = "Miniconda" }
)

foreach ($pkg in $packages) {
    Write-Host "    Installing $($pkg.Label)..."
    winget install --id $pkg.Id -e --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
        Write-Fail "$($pkg.Label) install failed (winget exit code $LASTEXITCODE). Try running winget manually: winget install --id $($pkg.Id)"
    }
    Write-Ok "$($pkg.Label) installed"
}

Update-SessionPath

if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    Write-Ok "ffmpeg in PATH: $((ffmpeg -version 2>&1 | Select-Object -First 1) -replace 'ffmpeg version ','')"
} else {
    Write-Warn "ffmpeg not in PATH yet — open a new PowerShell window after setup completes if needed."
}

# ── COLMAP ────────────────────────────────────────────────────────────────────

Write-Step "Installing COLMAP (CUDA build)"

if (Get-Command colmap -ErrorAction SilentlyContinue) {
    Write-Ok "COLMAP already in PATH: $(colmap --version 2>&1)"
} else {
    $colmapDir = "C:\tools\colmap"

    Write-Host "    Fetching latest COLMAP release from GitHub..."
    try {
        $rel = Invoke-RestMethod "https://api.github.com/repos/colmap/colmap/releases/latest"
    } catch {
        Write-Fail "Could not reach GitHub API. Check your internet connection: $_"
    }
    $tag   = $rel.tag_name
    $asset = $rel.assets | Where-Object { $_.name -like "*windows-cuda*" } | Select-Object -First 1
    if (-not $asset) {
        Write-Fail "No windows-cuda asset found in COLMAP release $tag. Check https://github.com/colmap/colmap/releases manually."
    }

    Write-Host "    Downloading COLMAP $tag ($([math]::Round($asset.size / 1MB)) MB)..."
    $zipPath = "$env:TEMP\colmap.zip"
    Invoke-WebRequest $asset.browser_download_url -OutFile $zipPath

    Write-Host "    Extracting to $colmapDir..."
    if (Test-Path $colmapDir) { Remove-Item $colmapDir -Recurse -Force }
    Expand-Archive $zipPath -DestinationPath $colmapDir -Force
    Remove-Item $zipPath

    $colmapExe = Get-ChildItem $colmapDir -Recurse -Filter "colmap.exe" | Select-Object -First 1
    if (-not $colmapExe) { Write-Fail "colmap.exe not found after extraction. The archive layout may have changed." }

    $colmapBin = $colmapExe.DirectoryName
    $userPath  = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$colmapBin*") {
        [System.Environment]::SetEnvironmentVariable("PATH", "$userPath;$colmapBin", "User")
    }
    Update-SessionPath
    Write-Ok "COLMAP $tag installed → $colmapBin"
}

# ── nerfstudio conda environment ──────────────────────────────────────────────

Write-Step "Setting up nerfstudio conda environment"

$condaExe = Find-Conda
if (-not $condaExe) {
    Write-Fail "conda not found after Miniconda install. Open a new PowerShell window and re-run this script."
}
Write-Ok "conda: $condaExe"

$envList = & $condaExe env list 2>&1
if ($envList -match "\bnerfstudio\b") {
    Write-Ok "conda env 'nerfstudio' already exists"
} else {
    Write-Host "    Creating conda env 'nerfstudio' (Python 3.10)..."
    & $condaExe create -n nerfstudio python=3.10 -y 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Fail "conda env creation failed" }
    Write-Ok "conda env created"
}

Write-Host "    Installing PyTorch with CUDA 11.8 wheels..."
& $condaExe run -n nerfstudio pip install torch torchvision `
    --index-url https://download.pytorch.org/whl/cu118 --quiet 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Fail "PyTorch install failed" }
Write-Ok "PyTorch (CUDA 11.8) installed"

Write-Host "    Installing nerfstudio (this takes several minutes)..."
& $condaExe run -n nerfstudio pip install nerfstudio --quiet 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Fail "nerfstudio install failed" }
Write-Ok "nerfstudio installed"

Write-Host "    Verifying GPU visibility inside nerfstudio env..."
$gpuCheck = & $condaExe run -n nerfstudio python -c "import torch; print(torch.cuda.get_device_name(0))" 2>&1
if ($LASTEXITCODE -ne 0 -or $gpuCheck -match "Error|not available") {
    Write-Warn "PyTorch cannot see the GPU: $gpuCheck"
    Write-Warn "Ensure NVIDIA driver >= 520 is installed, then re-run this script."
} else {
    Write-Ok "PyTorch sees GPU: $gpuCheck"
}

# ── SuperSplat ────────────────────────────────────────────────────────────────

Write-Step "SuperSplat (browser-based, no install required)"
Write-Ok "Opening supersplat.playcanvas.com — bookmark it for the review and export step."
Start-Process "https://supersplat.playcanvas.com"

# ── Working directory structure ───────────────────────────────────────────────

Write-Step "Creating working directory structure"

$workRoot = "$env:USERPROFILE\CTC-Splatting"
foreach ($d in @("incoming", "frames", "colmap_out", "outputs", "export", "done")) {
    New-Item -ItemType Directory -Path "$workRoot\$d" -Force | Out-Null
}
Write-Ok "Directories created under $workRoot"

# Copy process-scene.ps1 next to the working dirs for easy access
$processSrc = Join-Path $PSScriptRoot "process-scene.ps1"
$processDst = "$workRoot\process-scene.ps1"
if (Test-Path $processSrc) {
    Copy-Item $processSrc $processDst -Force
    Write-Ok "process-scene.ps1 copied to $workRoot"
} else {
    Write-Warn "process-scene.ps1 not found at $processSrc — copy workstation\splatting\process-scene.ps1 to $workRoot manually."
}

# ── Summary ───────────────────────────────────────────────────────────────────

Write-Step "Setup complete — installed versions"

$summary = [ordered]@{
    "ffmpeg"     = { (ffmpeg -version 2>&1 | Select-Object -First 1) -replace "ffmpeg version ","" }
    "colmap"     = { (colmap --version 2>&1 | Select-Object -First 1) }
    "conda"      = { (& $condaExe --version 2>&1) -replace "conda ","" }
    "nerfstudio" = { (& $condaExe run -n nerfstudio python -m nerfstudio --version 2>&1 | Select-Object -First 1) }
    "node"       = { (node --version 2>&1) }
    "GPU"        = { $gpuCheck }
}

foreach ($kv in $summary.GetEnumerator()) {
    try   { $val = & $kv.Value }
    catch { $val = "(not in PATH — open a new shell)" }
    Write-Host ("    {0,-15} {1}" -f $kv.Key, $val)
}

Write-Host ""
Write-Host "    Working directory  : $workRoot" -ForegroundColor Cyan
Write-Host "    Processing script  : $processDst" -ForegroundColor Cyan
Write-Host "    SuperSplat viewer  : https://supersplat.playcanvas.com" -ForegroundColor Cyan
Write-Host ""
Write-Host "    File naming convention (required for NAS upload trigger):" -ForegroundColor Yellow
Write-Host "      YYYY-MM_property-slug_room-slug.splat"
Write-Host "      e.g.  2026-05_grand-palms_suite-101.splat"
Write-Host ""
Write-Host "    Next step:" -ForegroundColor Cyan
Write-Host "      1. Drop a short test video into: $workRoot\incoming\"
Write-Host "      2. Run: $processDst"
