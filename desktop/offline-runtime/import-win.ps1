$ErrorActionPreference = 'Stop'
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'amd64' }
$archive = Join-Path $PSScriptRoot ('runtime-' + $arch + '.tar.gz')
$expected = ((Get-Content -LiteralPath (Join-Path $PSScriptRoot ('runtime-' + $arch + '.sha256'))) -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw '离线镜像校验失败，未导入。' }
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (!$docker) { throw '请先离线安装并启动 Docker Desktop，使用 Linux 容器模式。' }
& $docker.Source load -i $archive
if ($LASTEXITCODE -ne 0) { throw '镜像导入失败。' }
Write-Host ('导入完成。工作区沙箱镜像：open-medical-runtime:0.5-' + $arch)
