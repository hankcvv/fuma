# Fuma 安装与部署说明

适用于 **Debian / Ubuntu** 等 Linux 服务器（x64）。Windows 开发机请用 WSL 或仅在服务器上执行部署命令。

---

## 一、脚本里已包含的自启动逻辑

仓库根目录 [`deploy.sh`](deploy.sh) 在启动 PM2 时会依次执行：

1. **`pm2 start`**：在 `server` 目录下启动 `index.js`（默认进程名 `fuma`，端口默认 `4000`，可通过环境变量 `PORT` / `PM2_NAME` 覆盖）。
2. **`pm2 save`**：保存当前进程列表，以便 PM2 恢复。
3. **开机自启（仅当当前用户为 root）**：执行  
   `pm2 startup systemd -u root --hp /root`  
   将 PM2 注册到 **systemd**，重启系统后会自动拉起已保存的进程。
4. 若第 3 步失败，脚本会提示你**手动**执行 `pm2 startup`，并把终端里输出的 **`sudo env PATH=...`** 整行执行一次；详情可看服务器上的 `/tmp/fuma-pm2-startup.txt`。

**非 root 用户**：脚本不会自动执行 `pm2 startup`，需在部署完成后自行运行 `pm2 startup` 并按提示完成。

验证自启是否生效：

```bash
pm2 status
systemctl list-units | grep -i pm2
# 重启后再次 pm2 status、curl http://127.0.0.1:4000/api/health
```

---

## 二、推荐：一键部署（首次）

### 1. 克隆代码

```bash
cd /opt
sudo git clone <你的_GitHub_仓库地址> fuma
sudo chown -R "$USER:$USER" /opt/fuma
cd /opt/fuma
```

私有仓库需提前配置 SSH 或 HTTPS Token。

### 2. 赋予执行权限并运行脚本

**全新系统（尚未安装 Node、PM2、Nginx 等）：**

```bash
chmod +x deploy.sh
./deploy.sh --install-system-deps
```

该选项会尝试：`apt` 安装基础依赖、通过 NodeSource 安装 **Node 20**、全局安装 **PM2**、安装 **Nginx**，并完成依赖安装、前端构建、PM2 启动及 **systemd 自启（root）**、Nginx 反代配置（可用 `--skip-nginx` 跳过）。

**系统已安装 Node 18+ 与 git、curl、pm2：**

```bash
chmod +x deploy.sh
./deploy.sh
```

### 3. 仅检查环境（不构建、不启动）

```bash
./deploy.sh --dry-run
```

### 4. 脚本常用参数

| 参数 | 含义 |
|------|------|
| `--install-system-deps` | 安装系统包、Node 20、PM2、Nginx（需 sudo/root） |
| `--skip-nginx` | 不写入 Nginx 配置，仅 Node 监听端口（如 `http://IP:4000`） |
| `--dry-run` | 只做环境与目录检查 |

环境变量（可选）：`PORT`（默认 4000）、`PM2_NAME`（默认 `fuma`）。

---

## 三、访问方式（不显示端口）

浏览器访问 **`http://服务器IP`** 使用的是 **80** 端口，需要 **Nginx** 把请求反代到本机 **`127.0.0.1:4000`**。

若只能 `http://IP:4000` 打开，说明未正确配置或未启用 Nginx 站点。可参考附录中的 Nginx 示例，并关闭默认站点：

```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

---

## 四、手动部署（不使用脚本时）

与脚本等价的大致步骤：

```bash
npm install && npm --prefix server install && npm --prefix web install
npm --prefix web run build
cd server && NODE_ENV=production pm2 start index.js --name fuma
pm2 save
sudo env PATH="$PATH:/usr/local/bin:/usr/bin" pm2 startup systemd -u root --hp /root   # root 示例；非 root 见 pm2 startup 提示
```

数据库默认开发为 SQLite：`server` 进程当前工作目录下的 **`app.db`**。生产环境如需 **MySQL**，在环境中配置 `DB_HOST` 等（参见 `server/db.js`），并执行迁移：`npm run migrate:mysql --prefix server`。

---

## 五、健康检查与日志

```bash
curl -s http://127.0.0.1:4000/api/health
pm2 logs fuma --lines 100
pm2 status
```

---

## 六、更新代码后重新发布

```bash
cd /opt/fuma
git pull
npm install
npm --prefix server install
npm --prefix web install
npm --prefix web run build
pm2 restart fuma
```

也可再次执行 `./deploy.sh`（注意会按脚本逻辑删除同名 PM2 进程后重建）。

---

## 七、安全与配置提示

- 生产环境请将 JWT 等密钥改为环境变量配置（勿长期使用默认弱密钥）。
- 放行防火墙端口：**80**（及配置 HTTPS 时的 **443**）；若暂不配置 Nginx，需放行应用端口（默认 **4000**）。
- 英文版通用步骤可参考仓库内 [`DEPLOYMENT.md`](DEPLOYMENT.md)（以 Ubuntu 为例）。

---

## 附录：Nginx 反代示例（HTTP）

```nginx
server {
    listen 80 default_server;
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
```

启用：`sites-available` / `sites-enabled`，`nginx -t` 后 `systemctl reload nginx`。
