#!/bin/sh
set -eu
BASE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$BASE"
ARCH="$(uname -m)"
case "$ARCH" in arm64) ARCH=arm64;; x86_64) ARCH=amd64;; *) echo '不支持此处理器架构'; exit 1;; esac
if command -v docker >/dev/null 2>&1; then DOCKER=docker
elif [ -x /usr/local/bin/docker ]; then DOCKER=/usr/local/bin/docker
elif [ -x /opt/homebrew/bin/docker ]; then DOCKER=/opt/homebrew/bin/docker
else echo '需要先离线安装并启动 Docker Desktop 或兼容的本地 Docker 环境。'; exit 1; fi
/usr/bin/shasum -a 256 -c "runtime-$ARCH.sha256"
"$DOCKER" load -i "runtime-$ARCH.tar.gz"
echo "导入完成。请在工作区的沙箱镜像中填写 open-medical-runtime:0.5-$ARCH"
