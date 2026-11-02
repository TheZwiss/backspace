$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$architecture = if ($args.Count -gt 0) { $args[0] } else { 'x64' }
$platform = if ($architecture -eq 'arm64') { 'ARM64' } else { 'x64' }
$build = Join-Path $root "build-$architecture"
$output = Join-Path $root "bin\$architecture"

cmake -S $root -B $build -A $platform
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
cmake --build $build --config Release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force -Path $output | Out-Null
Copy-Item -Force (Join-Path $build 'Release\backspace-dxgi-output-probe.exe') $output
