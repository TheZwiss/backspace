# Persistent local test environment for Windows (PowerShell 7+).
# Same stack as scripts/testenv.sh (server :3005 + Vite :5173) plus a local
# LiveKit SFU (:7880, dev keys), so voice channels work, and helpers to open
# Electron clients that each have their own profile and debugging port.
#
# Usage: scripts/testenv.ps1 [up|down|status|reset|client] [-Index N]
#   up       start LiveKit + server + web (idempotent), seed on first run
#   down     stop everything, keep the data
#   status   show which parts answer
#   reset    stop and delete .testenv/ (next `up` re-seeds)
#   client   open Electron client N (default 1) against the stack;
#            -FakeAudio file.wav plays that WAV as its microphone
#
# State lives in .testenv/ (gitignored). Users: ana and bia, both with the
# password below. Both belong to the space "Teste" (#general + a voice channel).
# Client N: profile .testenv/client-N, CDP on http://localhost:922N, so
# client 1 is :9221 and client 2 is :9222.
[CmdletBinding()]
param(
  [ValidateSet('up', 'down', 'status', 'reset', 'client')]
  [string]$Command = 'up',
  [ValidateRange(1, 9)]
  [int]$Index = 1,
  # client only: a WAV file played as the microphone (looped). Without it the
  # client has no fake devices and asks for the real microphone.
  [string]$FakeAudio = ''
)

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$State = Join-Path $Root '.testenv'
$Bin = Join-Path $State 'bin'
$Api = 'http://localhost:3005'
$Web = 'http://localhost:5173'
$LiveKitVersion = '1.13.11'
$LiveKitExe = Join-Path $Bin 'livekit-server.exe'
$Password = 'change-me-dev-password'

function Test-Port([int]$Port) {
  # Servers here listen on IPv4 only (Fastify, LiveKit) or IPv6 only (Vite), and
  # a refused connection takes about a second on Windows, so try each address
  # on its own with a timeout that outlasts that.
  foreach ($address in '127.0.0.1', '::1') {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
      $task = $client.ConnectAsync($address, $Port)
      if ($task.Wait(2000) -and $client.Connected) { return $true }
    } catch {
      continue
    } finally {
      $client.Dispose()
    }
  }
  return $false
}

function Stop-Tree([string]$PidFile) {
  if (-not (Test-Path $PidFile)) { return }
  $procId = [int](Get-Content $PidFile -Raw)
  if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
    & taskkill.exe /T /F /PID $procId *> $null
  }
  Remove-Item $PidFile -Force
}

function Install-LiveKit {
  if (Test-Path $LiveKitExe) { return }
  New-Item -ItemType Directory -Force $Bin | Out-Null
  $zip = Join-Path $Bin 'livekit.zip'
  $url = "https://github.com/livekit/livekit/releases/download/v$LiveKitVersion/livekit_${LiveKitVersion}_windows_amd64.zip"
  Write-Host "downloading LiveKit $LiveKitVersion"
  Invoke-WebRequest -Uri $url -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $Bin -Force
  Remove-Item $zip -Force
  if (-not (Test-Path $LiveKitExe)) { throw "livekit-server.exe missing after extracting $url" }
}

function Invoke-Json([string]$Method, [string]$Path, $Body, [string]$Token) {
  $headers = @{}
  if ($Token) { $headers['authorization'] = "Bearer $Token" }
  $params = @{ Method = $Method; Uri = "$Api$Path"; Headers = $headers; ContentType = 'application/json' }
  if ($null -ne $Body) { $params['Body'] = ($Body | ConvertTo-Json -Compress) }
  return Invoke-RestMethod @params
}

function Initialize-Seed {
  $ana = Invoke-Json 'POST' '/api/auth/register' @{ username = 'ana'; password = $Password; email = 'ana@test.local' } $null
  $bia = Invoke-Json 'POST' '/api/auth/register' @{ username = 'bia'; password = $Password; email = 'bia@test.local' } $null
  $space = Invoke-Json 'POST' '/api/spaces' @{ name = 'Teste' } $ana.token
  $spaceId = if ($space.id) { $space.id } else { $space.space.id }
  $invite = Invoke-Json 'POST' "/api/spaces/$spaceId/invite" @{} $ana.token
  Invoke-Json 'POST' '/api/spaces/join' @{ inviteCode = $invite.inviteCode } $bia.token | Out-Null
  New-Item -ItemType File -Force (Join-Path $State '.seeded') | Out-Null
}

function Start-Stack {
  New-Item -ItemType Directory -Force $State | Out-Null
  Install-LiveKit

  if (-not (Test-Port 7880)) {
    $lk = Start-Process -FilePath $LiveKitExe `
      -ArgumentList '--dev', '--bind', '127.0.0.1', '--node-ip', '127.0.0.1' `
      -RedirectStandardOutput (Join-Path $State 'livekit.log') `
      -RedirectStandardError (Join-Path $State 'livekit.err.log') `
      -WindowStyle Hidden -PassThru
    Set-Content (Join-Path $State 'livekit.pid') $lk.Id
  }

  if (-not ((Test-Port 3005) -and (Test-Port 5173))) {
    $env:DB_PATH = Join-Path $State 'test.db'
    $env:UPLOAD_DIR = Join-Path $State 'uploads'
    $env:BACKUP_DIR = Join-Path $State 'backups'
    $env:JWT_SECRET = 'motionlabsecretmotionlabsecret123456'
    $env:DOMAIN = 'localhost'
    $env:REGISTRATION_OPEN = 'true'
    $env:LIVEKIT_URL = 'ws://localhost:7880'
    $env:LIVEKIT_API_KEY = 'devkey'
    $env:LIVEKIT_API_SECRET = 'secret'
    $dev = Start-Process -FilePath 'pnpm.cmd' -ArgumentList 'dev' -WorkingDirectory $Root `
      -RedirectStandardOutput (Join-Path $State 'dev.log') `
      -RedirectStandardError (Join-Path $State 'dev.err.log') `
      -WindowStyle Hidden -PassThru
    Set-Content (Join-Path $State 'dev.pid') $dev.Id
  }

  foreach ($i in 1..90) {
    if ((Test-Port 3005) -and (Test-Port 5173) -and (Test-Port 7880)) { break }
    Start-Sleep -Seconds 1
  }
  foreach ($p in 3005, 5173, 7880) {
    if (-not (Test-Port $p)) { throw "port $p did not come up, see $State\dev.log, dev.err.log and livekit.err.log" }
  }
  if (-not (Test-Path (Join-Path $State '.seeded'))) { Initialize-Seed }
  Write-Host "up: web $Web  api $Api  livekit ws://localhost:7880  users ana, bia / $Password"
}

function Stop-Stack {
  Stop-Tree (Join-Path $State 'dev.pid')
  Stop-Tree (Join-Path $State 'livekit.pid')
  Get-ChildItem -Path $State -Filter 'client-*.pid' -ErrorAction SilentlyContinue | ForEach-Object { Stop-Tree $_.FullName }
  # A killed `pnpm dev` can leave the node children holding the ports.
  foreach ($port in 3005, 5173, 7880) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { & taskkill.exe /T /F /PID $_.OwningProcess *> $null }
  }
  Write-Host 'stopped'
}

function Start-Client([int]$N) {
  if (-not ((Test-Port 3005) -and (Test-Port 5173))) { throw 'the stack is not running, use: scripts/testenv.ps1 up' }
  $desktop = Join-Path $Root 'packages\desktop'
  if (-not (Test-Path (Join-Path $desktop 'dist\main.js'))) {
    Push-Location $desktop
    try { & pnpm.cmd build:ts; if ($LASTEXITCODE -ne 0) { throw 'desktop build:ts failed' } } finally { Pop-Location }
  }
  $electron = Join-Path $desktop 'node_modules\electron\dist\electron.exe'
  $profile = Join-Path $State "client-$N"
  $port = 9220 + $N
  $env:BACKSPACE_URL = $Web
  $arguments = @('.', "--user-data-dir=$profile", "--remote-debugging-port=$port")
  if ($FakeAudio) {
    if (-not (Test-Path $FakeAudio)) { throw "FakeAudio file not found: $FakeAudio" }
    $arguments += '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', "--use-file-for-fake-audio-capture=$((Resolve-Path $FakeAudio).Path)"
  }
  $proc = Start-Process -FilePath $electron -WorkingDirectory $desktop -PassThru -ArgumentList $arguments
  Set-Content (Join-Path $State "client-$N.pid") $proc.Id
  Write-Host "client ${N}: pid $($proc.Id), profile $profile, CDP http://localhost:$port"
}

switch ($Command) {
  'up' { Start-Stack }
  'down' { Stop-Stack }
  'status' {
    $parts = [ordered]@{ server = 3005; web = 5173; livekit = 7880 }
    foreach ($name in $parts.Keys) {
      Write-Host ("{0,-8} {1}" -f $name, $(if (Test-Port $parts[$name]) { 'running' } else { 'stopped' }))
    }
  }
  'reset' { Stop-Stack; if (Test-Path $State) { Remove-Item $State -Recurse -Force }; Write-Host 'reset' }
  'client' { Start-Client $Index }
}
