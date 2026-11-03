param([ValidateSet('x64','arm64')][string]$Architecture='x64')
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$build=Join-Path $root "build-$Architecture"
$output=Join-Path $root "bin/$Architecture"
New-Item -ItemType Directory -Force $output | Out-Null
$vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio=if(Test-Path $vswhere){ & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
if($visualStudio -and -not ($Architecture -eq 'x64' -and (Get-Command g++ -ErrorAction SilentlyContinue))){
  $platform=if($Architecture -eq 'arm64'){'ARM64'}else{'x64'}
  $version = [version](& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion)
  $year = if ($version.Major -ge 18) { '2026' } else { '2022' }
  cmake -S $root -B $build -G "Visual Studio $($version.Major) $year" -A $platform
  if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
  cmake --build $build --config Release
  if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
  Copy-Item -LiteralPath (Join-Path $build 'Release/backspace-shared-texture.exe') -Destination $output -Force
}elseif($Architecture -eq 'x64' -and (Get-Command g++ -ErrorAction SilentlyContinue)){
  g++ -std=c++17 -O2 -static -static-libgcc -static-libstdc++ -DWIN32_LEAN_AND_MEAN -DNOMINMAX (Join-Path $root 'main.cpp') -o (Join-Path $output 'backspace-shared-texture.exe') -ld3d11 -ldxgi -lgdi32 -luser32
  if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
}else{throw 'Install Visual Studio C++ tools (or MinGW g++ for x64).'}
