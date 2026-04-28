$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$vcvars = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
$source = Join-Path $repoRoot "native\fingerprint_wrap.cpp"
$outDir = Join-Path $repoRoot "native\bin"
$exe = Join-Path $outDir "fingerprint_wrap.exe"

if (!(Test-Path $vcvars)) {
    throw "MSVC vcvars64.bat not found at $vcvars"
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$cmd = "`"$vcvars`" && cl /std:c++17 /O2 /EHsc /nologo `"$source`" /Fe:`"$exe`" /Fo:`"$outDir\fingerprint_wrap.obj`""
cmd.exe /c $cmd
