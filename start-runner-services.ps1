# Syncbay Persistent Runner & Cloudflare Tunnel Supervisor
$cloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$tunnelToken = "eyJhIjoiYzY3OGNmNWMwZmM1ZWYzODA2ZWRhY2MxOGU2YTc2MmQiLCJ0IjoiMmNhYTExNjYtNjA3ZS00MGYxLThiMDUtZTE3YmIxZjQ3MTk3IiwicyI6Ik1XUXlaRFF4Wm1ZdFpESTRNUzAwTkRBNUxUZ3pPVGd0WXpJMFpXVmpNREUwWTJSaCJ9"
$runnerDir = "C:\dev\syncbay\runner"
$tsxPath = "C:\dev\syncbay\node_modules\tsx\dist\cli.mjs"
$runnerScript = "C:\dev\syncbay\runner\src\index.ts"

# 1. Kill any existing stale instances
Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process | Where-Object { $_.CommandLine -like "*runner\src\index.ts*" -or $_.CommandLine -like "*runner/src/index.ts*" } | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. Start Cloudflare Tunnel
Write-Host "Starting Cloudflare Tunnel daemon..."
Start-Process -FilePath $cloudflaredPath -ArgumentList "tunnel run --token $tunnelToken" -WindowStyle Hidden

# 3. Start Syncbay Runner Daemon
Write-Host "Starting Syncbay Runner Agent..."
Start-Process -FilePath "node.exe" -ArgumentList "`"$tsxPath`" `"$runnerScript`"" -WorkingDirectory $runnerDir -WindowStyle Hidden

Write-Host "Services started successfully."
