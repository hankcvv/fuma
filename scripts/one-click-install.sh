#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/var/www/fuma"
APP_NAME="fuma-server"
NODE_MAJOR="20"
SERVER_PORT="4000"
DOMAIN_OR_IP="${1:-_}"

echo "[1/8] Install system packages..."
apt update
apt install -y curl git nginx build-essential python3 make g++

echo "[2/8] Install nvm + Node.js ${NODE_MAJOR}..."
export NVM_DIR="${HOME}/.nvm"
if [ ! -s "${NVM_DIR}/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck source=/dev/null
source "${NVM_DIR}/nvm.sh"
nvm install "${NODE_MAJOR}"
nvm use "${NODE_MAJOR}"

echo "[3/8] Install project dependencies..."
cd "${APP_DIR}"
rm -rf node_modules server/node_modules web/node_modules
npm install
npm --prefix server install
npm --prefix web install

echo "[4/8] Build frontend..."
npm --prefix web run build

echo "[5/8] Install PM2..."
npm install -g pm2

echo "[6/8] Start service with PM2 (production)..."
cd "${APP_DIR}/server"
pm2 delete "${APP_NAME}" >/dev/null 2>&1 || true
NODE_ENV=production pm2 start index.js --name "${APP_NAME}"
pm2 save
pm2 startup systemd -u root --hp /root >/tmp/pm2-startup.txt 2>/dev/null || true
bash /tmp/pm2-startup.txt >/dev/null 2>&1 || true

if [ "${DOMAIN_OR_IP}" = "_" ]; then
  DOMAIN_OR_IP="$(hostname -I | awk '{print $1}')"
fi

echo "[7/8] Configure Nginx reverse proxy (${DOMAIN_OR_IP})..."
cat >/etc/nginx/sites-available/fuma <<EOF
server {
    listen 80;
    server_name ${DOMAIN_OR_IP};

    location / {
        proxy_pass http://127.0.0.1:${SERVER_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sf /etc/nginx/sites-available/fuma /etc/nginx/sites-enabled/fuma
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

echo "[8/8] Health checks..."
curl -sS "http://127.0.0.1:${SERVER_PORT}/api/auth/captcha" >/dev/null
curl -sSI "http://127.0.0.1/" | head -n 1

echo ""
echo "Done."
echo "Open: http://${DOMAIN_OR_IP}/"
echo "PM2: pm2 status"
echo "Logs: pm2 logs ${APP_NAME} --lines 100"
