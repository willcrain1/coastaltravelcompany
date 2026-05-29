#Requires -Version 5.1
<#
.SYNOPSIS
    Per-job Gaussian Splatting processing pipeline.
    Drop one video file in the incoming\ folder, then run this script.
    It runs ffmpeg → COLMAP → nerfstudio splatfacto → export, then
    opens the result in Explorer and SuperSplat for review.

.NOTES
    This script expects to live alongside the CTC-Splatting working
    directories (incoming\, frames\, colmap_out\, outputs\, export\, done\).
    setup-windows.ps1 copies it there automatically.
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

# ── Locate working root ───────────────────────────────────────────────────────

# Support running from the repo (workstation\splatting\) or from the work root
$workRoot = $PSScriptRoot
if (-not (Test-Path "$workRoot\incoming")) {
    $fallback = "$env:USERPROFILE\CTC-Splatting"
    if (Test-Path "$fallback\incoming") {
        $workRoot = $fallback
    } else {
        Write-Fail "Cannot find the CTC-Splatting working directories. Run setup-windows.ps1 first."
    }
}

$incoming  = "$workRoot\incoming"
$frames    = "$workRoot\frames"
$colmapOut = "$workRoot\colmap_out"
$outputs   = "$workRoot\outputs"
$exportDir = "$workRoot\export"

Write-Host "`nCTC Splatting Pipeline" -ForegroundColor Cyan
Write-Host "Working root: $workRoot"

# ── Locate conda ──────────────────────────────────────────────────────────────

$condaExe = Find-Conda
if (-not $condaExe) {
    Write-Fail "conda not found. Run setup-windows.ps1 first, or open a new PowerShell window."
}

# ── Find input video ──────────────────────────────────────────────────────────

Write-Step "Looking for video in incoming\"

$video = $null
foreach ($ext in @("*.mp4","*.mov","*.mkv","*.avi","*.mts","*.m2ts")) {
    $video = Get-ChildItem "$incoming\$ext" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($video) { break }
}
if (-not $video) {
    Write-Fail "No video file found in $incoming`nDrop a .mp4, .mov, .mkv, .avi, .mts, or .m2ts file there and re-run."
}

$slug = [System.IO.Path]::GetFileNameWithoutExtension($video.Name)

# Validate slug — the NAS upload script splits on *.splat so spaces/special chars break it
if ($slug -match '[^a-zA-Z0-9_\-]') {
    Write-Warn "Filename '$($video.Name)' contains characters other than letters, numbers, hyphens, and underscores."
    Write-Warn "Rename it to match the convention (e.g. 2026-05_grand-palms_suite-101.mp4) before uploading to the NAS."
}

Write-Ok "Video : $($video.Name)"
Write-Ok "Slug  : $slug"

# ── Frame extraction ──────────────────────────────────────────────────────────

Write-Step "Extracting frames with ffmpeg (fps=3, 4K)"

# Wipe and re-create the frames directory for a clean run
if (Test-Path $frames) { Remove-Item "$frames\*" -Force -Recurse -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $frames -Force | Out-Null

# fps=3: 3 frames/sec, enough overlap for a slow walkthrough pass
# scale=3840:-1: scale to 3840 px wide, preserve aspect ratio
# -q:v 2: near-lossless JPEG quality
$ffmpegArgs = @(
    "-i", $video.FullName,
    "-vf", "fps=3,scale=3840:-1",
    "-q:v", "2",
    "$frames\%05d.jpg",
    "-y"
)
& ffmpeg @ffmpegArgs
if ($LASTEXITCODE -ne 0) { Write-Fail "ffmpeg failed. Is ffmpeg installed? Run setup-windows.ps1." }

$frameCount = (Get-ChildItem "$frames\*.jpg" -ErrorAction SilentlyContinue).Count
Write-Ok "$frameCount frames extracted"

if ($frameCount -lt 100) {
    Write-Warn "Fewer than 100 frames — the video may be too short for reliable reconstruction."
    Write-Warn "Aim for 200-600 frames (3-5 min of footage at fps=3). Consider bumping to fps=5 for short clips."
}

# ── COLMAP reconstruction ─────────────────────────────────────────────────────

Write-Step "COLMAP reconstruction via ns-process-data"

$colmapScene = "$colmapOut\$slug"
New-Item -ItemType Directory -Path $colmapScene -Force | Out-Null

& $condaExe run -n nerfstudio ns-process-data images `
    --data "$frames" `
    --output-dir "$colmapScene"
if ($LASTEXITCODE -ne 0) {
    Write-Fail "ns-process-data (COLMAP) failed.`nCommon causes: too few frames, low overlap, dark or blurry footage, or mirrors causing duplicate geometry."
}

# Report registration rate
$transformsJson = "$colmapScene\transforms.json"
if (Test-Path $transformsJson) {
    try {
        $transforms  = Get-Content $transformsJson -Raw | ConvertFrom-Json
        $registered  = $transforms.frames.Count
        $pct         = if ($frameCount -gt 0) { [math]::Round(($registered / $frameCount) * 100) } else { 0 }
        Write-Ok "$registered / $frameCount frames registered ($pct%)"
        if ($pct -lt 80) {
            Write-Warn "Less than 80% of frames registered."
            Write-Warn "Consider reshooting with slower movement, more overlap, or better / more even lighting."
        }
    } catch {
        Write-Ok "COLMAP reconstruction complete (could not parse transforms.json for stats)"
    }
} else {
    Write-Ok "COLMAP reconstruction complete"
}

# ── 3DGS training ─────────────────────────────────────────────────────────────

Write-Step "Training Gaussian Splatting model (splatfacto)"
Write-Host "    This takes 30-60 min on an RTX 3070. Watch VRAM in Task Manager." -ForegroundColor Yellow
Write-Host "    If you see an out-of-memory error, re-run ns-train with:" -ForegroundColor Yellow
Write-Host "      --pipeline.model.max-num-gaussians 1500000" -ForegroundColor Yellow

& $condaExe run -n nerfstudio ns-train splatfacto `
    --data "$colmapScene" `
    --output-dir "$outputs"
if ($LASTEXITCODE -ne 0) {
    Write-Fail "ns-train failed. Check the output above.`nIf CUDA out of memory: re-run with --pipeline.model.max-num-gaussians 1500000"
}
Write-Ok "Training complete"

# ── Export to PLY ─────────────────────────────────────────────────────────────

Write-Step "Exporting to PLY"

# Find the most recently modified config.yml under outputs\
$config = Get-ChildItem "$outputs" -Recurse -Filter "config.yml" -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending |
          Select-Object -First 1
if (-not $config) {
    Write-Fail "No config.yml found under $outputs. Training may not have completed successfully."
}
Write-Ok "Using config: $($config.FullName)"

$exportScene = "$exportDir\$slug"
New-Item -ItemType Directory -Path $exportScene -Force | Out-Null

& $condaExe run -n nerfstudio ns-export gaussian-splat `
    --load-config "$($config.FullName)" `
    --output-dir "$exportScene"
if ($LASTEXITCODE -ne 0) { Write-Fail "ns-export failed. Check the output above." }

$plyFile = Get-ChildItem "$exportScene\*.ply" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $plyFile) { Write-Fail "No .ply file found in $exportScene after export." }

$plySizeMB = [math]::Round($plyFile.Length / 1MB, 1)
Write-Ok "Exported: $($plyFile.Name) ($plySizeMB MB)"

# ── Open for review ───────────────────────────────────────────────────────────

Write-Step "Opening export folder and SuperSplat"
Invoke-Item $exportScene
Start-Process "https://supersplat.playcanvas.com"

# ── Next-step instructions ────────────────────────────────────────────────────

$nasSlug    = $slug     # rename to YYYY-MM_property_room before NAS upload if not already
$splatName  = "${slug}.splat"

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Processing complete — review and deliver" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "  PLY file : $($plyFile.FullName) ($plySizeMB MB)"
Write-Host ""
Write-Host "  Step 1 — Review and convert in SuperSplat (now open in browser):"
Write-Host "    a. Drag $($plyFile.Name) into the SuperSplat window"
Write-Host "    b. Orbit the scene and check for floaters or black patches"
Write-Host "    c. Use the selection tool to delete any floaters"
Write-Host "    d. File > Export > Save as .splat"
Write-Host "    e. Save as: $exportScene\$splatName"
Write-Host "       (the .splat will be ~5-10x smaller than the PLY)"
Write-Host ""
Write-Host "  Step 2 — Copy to NAS (two separate destinations):" -ForegroundColor Yellow
Write-Host "    Archive  : $($plyFile.Name)"
Write-Host "               → NAS: 3d-walkthroughs\$nasSlug\export\$($plyFile.Name)"
Write-Host "    R2 upload: $splatName"
Write-Host "               → NAS: 3d-walkthroughs\splats-incoming\$splatName"
Write-Host "       The NAS sync script picks up the .splat within 2 minutes"
Write-Host "       and uploads it to R2 automatically."
Write-Host ""
Write-Host "  Naming convention reminder:" -ForegroundColor Yellow
Write-Host "    YYYY-MM_property-slug_room-slug.splat"
Write-Host "    e.g. 2026-05_grand-palms_suite-101.splat"
if ($slug -notmatch '^\d{4}-\d{2}_') {
    Write-Host "    NOTE: '$slug' does not match the convention — rename before copying to the NAS." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
