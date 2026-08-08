#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/azureuser/browser-use-bridge"
REPO="https://github.com/anasalsawy/browser-use-bridge.git"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required" >&2
  exit 1
fi

if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO" "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only
fi

cd "$APP_DIR"
npm install --omit=dev

if [ ! -f .env ]; then
  TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  cat > .env <<EOF
PORT=8800
VM_EXEC_TOKEN=$TOKEN
VM_WORKDIR=/home/azureuser
VM_MAX_TIMEOUT_MS=120000
EOF
  chmod 600 .env
  echo "Generated VM_EXEC_TOKEN in $APP_DIR/.env"
else
  echo "Existing .env preserved"
fi

sudo cp deploy/vm-agent.service /etc/systemd/system/vm-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now vm-agent
sudo systemctl --no-pager --full status vm-agent || true

echo "VM agent installed. Local endpoint: http://127.0.0.1:8800/mcp"
