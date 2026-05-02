# Fuma Ubuntu 22.04 Deployment Guide

This document explains how to deploy this project on a fresh Ubuntu 22.04 x64 server.

## 1) Server Preparation

```bash
sudo apt update
sudo apt install -y git curl build-essential nginx
```

`build-essential` is required because `better-sqlite3` may need native build tools.

## 2) Install Node.js (LTS)

Use Node.js 20 LTS for stability:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 3) Clone Your GitHub Repository

```bash
cd /opt
sudo git clone <YOUR_GITHUB_REPO_URL> fuma
sudo chown -R $USER:$USER /opt/fuma
cd /opt/fuma
```

## 4) Install Dependencies

Install root + server + web dependencies:

```bash
npm install
npm --prefix server install
npm --prefix web install
```

## 5) Build Frontend

```bash
npm --prefix web run build
```

Frontend static files will be generated in `web/dist`.

## 6) Run Backend in Production

Install PM2 globally:

```bash
sudo npm install -g pm2
```

Start backend:

```bash
cd /opt/fuma/server
pm2 start index.js --name fuma-server --env production
pm2 save
pm2 startup
```

By default, backend listens on port `4000`.

## 7) Configure Nginx Reverse Proxy

Create Nginx config:

```bash
sudo tee /etc/nginx/sites-available/fuma >/dev/null <<'EOF'
server {
    listen 80;
    server_name _;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
```

Enable and reload:

```bash
sudo ln -sf /etc/nginx/sites-available/fuma /etc/nginx/sites-enabled/fuma
sudo nginx -t
sudo systemctl reload nginx
```

Now access server IP in browser.

## 8) Optional: HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <YOUR_DOMAIN>
```

## 9) Daily Update / Redeploy

Whenever you push new code:

```bash
cd /opt/fuma
git pull
npm install
npm --prefix server install
npm --prefix web install
npm --prefix web run build
pm2 restart fuma-server
```

## 10) Health Checks

Project backend health endpoint:

```bash
curl http://127.0.0.1:4000/api/health
```

PM2 checks:

```bash
pm2 status
pm2 logs fuma-server --lines 200
```

Nginx checks:

```bash
sudo systemctl status nginx
sudo tail -n 200 /var/log/nginx/error.log
```

## 11) Common Issues

### A) `better-sqlite3` NODE_MODULE_VERSION mismatch

This means Node version changed after install. Fix:

```bash
cd /opt/fuma
npm --prefix server rebuild better-sqlite3
pm2 restart fuma-server
```

If still failing:

```bash
rm -rf /opt/fuma/server/node_modules
npm --prefix server install
```

### B) Frontend build fails

Run:

```bash
cd /opt/fuma
npm --prefix web run build
```

Fix reported compile errors, then redeploy.

### C) Port 4000 already in use

Find process:

```bash
sudo lsof -i :4000
```

Kill conflicting process or run app on another port and update Nginx `proxy_pass`.

---

## Notes for This Project

- Server entry: `server/index.js`
- Root start script: `npm run start` (build web + start server)
- Production mode serves frontend from `web/dist`
- Current JWT secret is hardcoded in server code. For production security, move it to environment variables before internet exposure.
