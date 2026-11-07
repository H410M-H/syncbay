#!/usr/bin/env bash
# One-time / idempotent setup for an Alibaba Cloud ECS (Ubuntu 22.04/24.04 or Alibaba Cloud Linux 3).
# Run from a checkout of the syncbay repo:  sudo bash deploy/alibaba-ecs/setup.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "[setup] Installing Docker"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y ca-certificates curl git
    curl -fsSL https://get.docker.com | sh
  else
    # Alibaba Cloud Linux 3 / RHEL-compatible
    dnf install -y dnf-plugins-core git
    dnf config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
    dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi
fi
systemctl enable --now docker

# Small instances (1 vCPU / 1 GiB) need swap for npm installs and image builds.
if ! swapon --show | grep -q /swapfile; then
  echo "[setup] Adding 2 GiB swap"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^RUNNER_SECRET=.*/RUNNER_SECRET=$(openssl rand -hex 32)/" .env
  echo "[setup] Created deploy/alibaba-ecs/.env with a fresh RUNNER_SECRET."
  echo "        Edit RUNNER_DOMAIN / RUNNER_TLS / RUNNER_DB_HOST, copy RUNNER_SECRET into Vercel, then rerun."
  exit 0
fi

docker compose up -d --build
echo "[setup] Runner is starting. Check: curl -fsS https://\$(grep ^RUNNER_DOMAIN= .env | cut -d= -f2)/health"
