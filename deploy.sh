#!/usr/bin/env bash
# Fuma 一键部署（面向 Debian / Ubuntu 系 Linux 服务器）
# 用法：
#   chmod +x deploy.sh
#   ./deploy.sh                    # 仅检测环境并构建、启动 PM2（需已装 Node≥18、git、npm）
#   ./deploy.sh --install-system-deps   # 尝试用 apt 安装系统依赖、Node 20、PM2、并写入 Nginx 反代
#   ./deploy.sh --skip-nginx       # 不配置 Nginx（只 PM2）
#   ./deploy.sh --dry-run          # 只跑环境检查，不构建、不启动
set -euo pipefail

readonly MIN_NODE_MAJOR=18
readonly RECOMMEND_NODE_MAJOR=20
readonly APP_PORT="${PORT:-4000}"
readonly PM2_NAME="${PM2_NAME:-fuma}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

die() { echo -e "${RED}[失败]${NC} $*" >&2; exit 1; }
warn() { echo -e "${YELLOW}[警告]${NC} $*" >&2; }
ok() { echo -e "${GREEN}[通过]${NC} $*"; }
info() { echo -e "${BLUE}[信息]${NC} $*"; }

INSTALL_SYSTEM_DEPS=false
SKIP_NGINX=false
DRY_RUN=false

usage() {
  cat <<'EOF'
用法: ./deploy.sh [选项]

  --install-system-deps   使用 apt 安装 git/curl/build-essential/nginx，安装 Node 20（NodeSource）、全局 PM2，并写入 Nginx 站点（需 sudo）
  --skip-nginx            不生成/覆盖 Nginx 配置（仍可用 PM2）
  --dry-run                 只做环境与依赖检查，不执行 npm build / pm2

需要：在项目仓库根目录执行（与 package.json 同级）。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-system-deps) INSTALL_SYSTEM_DEPS=true ;;
    --skip-nginx) SKIP_NGINX=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（使用 --help）" ;;
  esac
  shift
done

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

need_sudo() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo -n true 2>/dev/null || die "需要 sudo 权限（安装系统包或写 Nginx）。请登录可 sudo 的用户后重试，或先配置 sudo NOPASSWD。"
    return 0
  fi
  die "需要 root 或 sudo 才能安装系统依赖"
}

require_project_layout() {
  [[ -f "$PROJECT_ROOT/package.json" ]] || die "未找到根目录 package.json，请在仓库根目录运行本脚本"
  [[ -f "$PROJECT_ROOT/server/package.json" ]] || die "未找到 server/package.json"
  [[ -f "$PROJECT_ROOT/web/package.json" ]] || die "未找到 web/package.json"
  [[ -f "$PROJECT_ROOT/server/index.js" ]] || die "未找到 server/index.js"
  ok "项目结构检查（根目录 / server / web）"
}

check_os() {
  info "操作系统"
  uname -a || true
  if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    ok "发行版: ${PRETTY_NAME:-unknown}"
    case "${ID:-}" in
      debian|ubuntu|linuxmint|pop) ;;
      *) warn "未在 Debian/Ubuntu 系列上测试，脚本中的 apt 命令可能不适用" ;;
    esac
  else
    warn "未找到 /etc/os-release"
  fi
}

check_user_and_paths() {
  info "当前用户: $(whoami) (uid=$(id -u))"
  [[ -w "$PROJECT_ROOT" ]] || die "当前用户对项目目录无写权限: $PROJECT_ROOT"
  ok "项目目录可写"
}

check_disk_and_mem() {
  info "磁盘（项目所在分区）"
  df -h "$PROJECT_ROOT" || true
  local avail
  avail="$(df -Pk "$PROJECT_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [[ -n "${avail:-}" && "$avail" -lt 512000 ]]; then
    warn "可用磁盘不足约 500MB，构建可能失败"
  else
    ok "磁盘空间大致充足（KB 可用: ${avail:-unknown}）"
  fi
  if command -v free >/dev/null 2>&1; then
    info "内存概况"; free -h || true
  fi
}

check_network_tools() {
  command -v curl >/dev/null 2>&1 || die "缺少 curl（请先: sudo apt install -y curl，或改用 ./deploy.sh --install-system-deps）"
  ok "curl 可用"
}

check_git() {
  command -v git >/dev/null 2>&1 || die "缺少 git（请先: sudo apt install -y git，或改用 ./deploy.sh --install-system-deps）"
  ok "git 可用"
  if [[ -d "$PROJECT_ROOT/.git" ]]; then
    info "Git 分支: $(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  fi
}

check_node_npm() {
  info "Node / npm"
  if ! command -v node >/dev/null 2>&1; then
    die "未安装 Node.js。请安装 Node ${MIN_NODE_MAJOR}+（推荐 20 LTS），或带参数运行: ./deploy.sh --install-system-deps"
  fi
  if ! command -v npm >/dev/null 2>&1; then
    die "未安装 npm（Node 安装不完整）"
  fi
  local major
  major="$(node -p "parseInt(process.versions.node.split('.')[0],10)" 2>/dev/null || echo 0)"
  [[ "$major" -ge "$MIN_NODE_MAJOR" ]] || die "Node 版本过低: $(node -v)（需要 >= ${MIN_NODE_MAJOR}）"
  ok "Node $(node -v)，npm $(npm -v)"
}

check_build_chain() {
  # better-sqlite3 等需要编译时依赖 python3/make/g++
  if command -v dpkg >/dev/null 2>&1; then
    if dpkg -s build-essential >/dev/null 2>&1; then
      ok "build-essential 已安装"
    else
      warn "未检测到 build-essential，若 npm install 编译失败请执行: sudo apt install -y build-essential"
    fi
  fi
}

check_port_free() {
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | grep -q ":${APP_PORT} "; then
      warn "端口 ${APP_PORT} 已被占用，PM2 启动可能失败。检查: ss -ltn | grep ${APP_PORT}"
    else
      ok "端口 ${APP_PORT} 当前未被监听（或 ss 无法判断）"
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -i ":${APP_PORT}" >/dev/null 2>&1; then
      warn "端口 ${APP_PORT} 已被占用"
    else
      ok "端口 ${APP_PORT} 未被占用"
    fi
  else
    warn "未安装 ss/lsof，跳过端口检测"
  fi
}

run_install_system_deps() {
  need_sudo
  info "安装系统包: git curl ca-certificates build-essential nginx"
  sudo apt-get update -y
  sudo apt-get install -y git curl ca-certificates build-essential nginx

  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "parseInt(process.versions.node.split('.')[0],10)" 2>/dev/null || echo 0)"
    if [[ "$major" -ge "$MIN_NODE_MAJOR" ]]; then
      info "已存在 Node $(node -v)，跳过 NodeSource"
    else
      info "安装 Node ${RECOMMEND_NODE_MAJOR}.x（NodeSource）"
      curl -fsSL "https://deb.nodesource.com/setup_${RECOMMEND_NODE_MAJOR}.x" | sudo -E bash -
      sudo apt-get install -y nodejs
    fi
  else
    info "安装 Node ${RECOMMEND_NODE_MAJOR}.x（NodeSource）"
    curl -fsSL "https://deb.nodesource.com/setup_${RECOMMEND_NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  fi

  ok "Node $(node -v)，npm $(npm -v)"

  info "安装全局 PM2"
  sudo npm install -g pm2
  command -v pm2 >/dev/null 2>&1 || die "PM2 安装失败"
  ok "PM2 $(pm2 -v)"
}

configure_nginx() {
  need_sudo
  local site="/etc/nginx/sites-available/fuma"
  info "写入 Nginx 配置: $site"
  sudo tee "$site" >/dev/null <<EOF
server {
    listen 80;
    server_name _;
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  sudo ln -sf "$site" /etc/nginx/sites-enabled/fuma
  sudo nginx -t
  sudo systemctl reload nginx
  ok "Nginx 已指向 http://127.0.0.1:${APP_PORT}"
}

install_and_build() {
  info "安装 npm 依赖（根目录、server、web）"
  npm install
  npm --prefix server install
  npm --prefix web install

  info "编译原生模块（better-sqlite3 等）"
  npm --prefix server rebuild better-sqlite3 2>/dev/null || true

  info "构建前端"
  npm --prefix web run build
  [[ -f "$PROJECT_ROOT/web/dist/index.html" ]] || die "前端构建失败：缺少 web/dist/index.html"
  ok "前端已生成 web/dist"
}

start_pm2() {
  command -v pm2 >/dev/null 2>&1 || die "未找到 pm2。请先: sudo npm install -g pm2 或使用 --install-system-deps"
  info "PM2 启动（工作目录: $PROJECT_ROOT/server，数据库 ./app.db 将写在该目录）"
  cd "$PROJECT_ROOT/server"
  export NODE_ENV=production
  pm2 delete "$PM2_NAME" 2>/dev/null || true
  pm2 start index.js --name "$PM2_NAME" --update-env
  pm2 save
  ok "PM2 应用名: $PM2_NAME（端口 ${APP_PORT}，可用 pm2 logs $PM2_NAME）"
}

health_check() {
  sleep 2
  if curl -sf "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null; then
    ok "健康检查: GET http://127.0.0.1:${APP_PORT}/api/health 正常"
  else
    warn "健康检查失败，请查看: pm2 logs ${PM2_NAME}"
  fi
}

# ---------- main ----------
echo ""
echo "========== Fuma 部署脚本 — 环境检查 =========="
check_os
check_user_and_paths
check_disk_and_mem
require_project_layout

if [[ "$INSTALL_SYSTEM_DEPS" == true ]]; then
  run_install_system_deps
else
  check_network_tools
  check_git
fi

check_node_npm
check_build_chain
check_port_free

echo ""
echo "========== 检查结果摘要 =========="
ok "必须通过项已完成；若有「警告」请按需处理后再上线"

if [[ "$DRY_RUN" == true ]]; then
  info "已指定 --dry-run，退出（未构建、未启动）"
  exit 0
fi

echo ""
echo "========== 安装依赖并构建 =========="
install_and_build

echo ""
echo "========== 进程管理（PM2） =========="
start_pm2

if [[ "$SKIP_NGINX" != true ]]; then
  if command -v nginx >/dev/null 2>&1 && [[ "${EUID:-$(id -u)}" -eq 0 || command -v sudo >/dev/null 2>&1 ]]; then
    echo ""
    echo "========== Nginx 反代 =========="
    if [[ "${EUID:-$(id -u)}" -eq 0 ]] || sudo -n true 2>/dev/null; then
      configure_nginx || warn "Nginx 配置失败（可稍后手动配置或使用 --skip-nginx）"
    else
      warn "无法无交互 sudo，跳过 Nginx。请手动反代 80 -> ${APP_PORT}，或重新运行并输入 sudo 密码"
    fi
  else
    warn "未安装 nginx 或无 sudo，跳过 Nginx 配置（对外可直接访问 http://服务器IP:${APP_PORT} 若防火墙放行）"
  fi
else
  info "已 --skip-nginx，跳过 Nginx"
fi

echo ""
echo "========== 健康检查 =========="
health_check

echo ""
ok "部署流程结束。常用命令: pm2 status | pm2 logs ${PM2_NAME} | curl http://127.0.0.1:${APP_PORT}/api/health"
