# start_local.ps1 — Run all Eddyi Trading Engine services natively on Windows
# Usage:  .\scripts\start_local.ps1
# Stop:   Press Ctrl+C (kills all child processes)

param(
    [switch]$SkipDashboard,
    [switch]$SkipApi,
    [int]$DashboardPort = 3000,
    [int]$ApiPort = 8000
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host ""
Write-Host "  EDDYI TRADING ENGINE — Local Startup" -ForegroundColor Green
Write-Host "  =====================================" -ForegroundColor DarkGray
Write-Host ""

# ── .env check ────────────────────────────────────────────────────────────
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Host "  [!] Created .env from .env.example — fill in your API keys!" -ForegroundColor Yellow
    } else {
        Write-Host "  [!] No .env file found. Some features may not work." -ForegroundColor Yellow
    }
}

# ── Redis check (optional) ────────────────────────────────────────────────
$redisOk = $false
try {
    $r = redis-cli ping 2>$null
    if ($r -eq "PONG") {
        $redisOk = $true
        Write-Host "  [OK] Redis is running" -ForegroundColor Green
    }
} catch {}

if (-not $redisOk) {
    Write-Host "  [--] Redis not found — engine will run in single-instance mode" -ForegroundColor DarkYellow
    Write-Host "       (Distributed locking and live feed disabled)" -ForegroundColor DarkGray
    Write-Host "       To install: winget install Redis.Redis  or  use Docker" -ForegroundColor DarkGray
}
Write-Host ""

# ── Track child PIDs for cleanup ──────────────────────────────────────────
$jobs = @()

function Cleanup {
    Write-Host "`n  Shutting down..." -ForegroundColor Yellow
    foreach ($j in $script:jobs) {
        try {
            Stop-Job $j -ErrorAction SilentlyContinue
            Remove-Job $j -Force -ErrorAction SilentlyContinue
        } catch {}
    }
    Write-Host "  All services stopped." -ForegroundColor Green
}

# Trap Ctrl+C
$null = Register-EngineEvent PowerShell.Exiting -Action { Cleanup } -ErrorAction SilentlyContinue

# ── 1. API Gateway (uvicorn) ──────────────────────────────────────────────
if (-not $SkipApi) {
    Write-Host "  Starting API Gateway on :$ApiPort ..." -ForegroundColor Cyan
    $apiJob = Start-Job -ScriptBlock {
        param($root, $port)
        Set-Location $root
        & python -m uvicorn api_server:app --host 0.0.0.0 --port $port --log-level info 2>&1
    } -ArgumentList $Root, $ApiPort
    $jobs += $apiJob
    Write-Host "  [OK] API Gateway → http://localhost:$ApiPort" -ForegroundColor Green
}

# ── 2. Dashboard (Next.js) ───────────────────────────────────────────────
if (-not $SkipDashboard) {
    # Check if dashboard is built
    if (-not (Test-Path "dashboard/.next")) {
        Write-Host "  Building dashboard (first time)..." -ForegroundColor Yellow
        & npx next build dashboard 2>&1 | Out-Null
    }
    Write-Host "  Starting Dashboard on :$DashboardPort ..." -ForegroundColor Cyan
    $dashJob = Start-Job -ScriptBlock {
        param($root, $port)
        Set-Location $root
        & npx next start dashboard --port $port 2>&1
    } -ArgumentList $Root, $DashboardPort
    $jobs += $dashJob
    Write-Host "  [OK] Dashboard → http://localhost:$DashboardPort" -ForegroundColor Green
}

# ── 3. Trading Bot (main.py) ─────────────────────────────────────────────
Write-Host "  Starting Trading Engine ..." -ForegroundColor Cyan
Write-Host ""
Write-Host "  ─────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  Services running:" -ForegroundColor White
if (-not $SkipApi) { Write-Host "    API Gateway   → http://localhost:$ApiPort" -ForegroundColor Cyan }
if (-not $SkipDashboard) { Write-Host "    Dashboard     → http://localhost:$DashboardPort" -ForegroundColor Cyan }
Write-Host "    Trading Bot   → main.py (foreground)" -ForegroundColor Cyan
if ($redisOk) { Write-Host "    Redis         → localhost:6379" -ForegroundColor Cyan }
Write-Host "  ─────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  Press Ctrl+C to stop all services" -ForegroundColor DarkGray
Write-Host ""

try {
    & python main.py
} finally {
    Cleanup
}
