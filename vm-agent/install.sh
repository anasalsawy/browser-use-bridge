#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/vm-control-agent"
SERVICE="vm-control-agent"
USER_NAME="${SUDO_USER:-$USER}"
REPO_RAW="https://raw.githubusercontent.com/anasalsawy/browser-use-bridge/main/vm-agent/server.py"

sudo mkdir -p "$INSTALL_DIR"
sudo curl -fsSL "$REPO_RAW" -o "$INSTALL_DIR/server.py"
sudo chown -R root:root "$INSTALL_DIR"
sudo chmod 755 "$INSTALL_DIR/server.py"

TOKEN_FILE="$INSTALL_DIR/token"
if [ ! -f "$TOKEN_FILE" ]; then
  TOKEN="$(openssl rand -hex 32)"
  echo "$TOKEN" | sudo tee "$TOKEN_FILE" >/dev/null
  sudo chmod 600 "$TOKEN_FILE"
else
  TOKEN="$(sudo cat "$TOKEN_FILE")"
fi

sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<EOF
[Unit]
Description=VM Control Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$INSTALL_DIR
Environment=VM_AGENT_TOKEN=$TOKEN
Environment=VM_AGENT_PORT=8799
ExecStart=/usr/bin/python3 $INSTALL_DIR/server.py
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=/tmp /var/tmp

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE"
sudo systemctl --no-pager --full status "$SERVICE" || true

echo
echo "VM Control Agent installed."
echo "Local endpoint: http://127.0.0.1:8799"
echo "Token stored at: $TOKEN_FILE"
echo "IMPORTANT: keep the token private."
