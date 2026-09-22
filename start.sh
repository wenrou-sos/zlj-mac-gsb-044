#!/usr/bin/env bash
# 旅行社组团与计调平台 · 一键启动脚本
#
# 用法：
#   ./start.sh            生产模式：检查依赖 → 必要时安装/编译 → 灌演示数据(首次) → 构建前端 → 单端口启动 http://localhost:4000
#   ./start.sh dev        开发模式：检查依赖 → 必要时灌种子 → 并行启动 API(4000) + Vite(5173)，热更新
#   ./start.sh seed       仅重置演示数据
#   PORT=8080 ./start.sh  自定义端口
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && p)"
cd "$ROOT"
MODE="${1:-prod}"
PORT="${PORT:-4000}"

# ---- 0. 环境检查 ----
command -v node >/dev/null || { echo "❌ 未检测到 node（建议 Node 18+）"; exit 1; }
echo "✅ Node $(node -v)"

# 个别容器把 cc 指向了占位脚本，better-sqlite3 本地编译会失败，自动改用系统 gcc/g++
if command -v gcc >/dev/null && command -v g++ >/dev/null; then
  export CC="$(command -v gcc)" CXX="$(command -v g++)"
  echo "✅ 编译器：$CC / $CXX"
fi

# ---- 1. 依赖安装（含 better-sqlite3 原生模块编译） ----
install_deps() {
  if ! node -e "require.resolve('better-sqlite3')" >/dev/null 2>&1 \
     || ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
    echo "📦 安装后端依赖（better-sqlite3 如需本地编译请稍候）…"
    npm install
  fi
  if [ ! -d client/node_modules ]; then
    echo "📦 安装前端依赖…"
    npm --prefix client install
  fi
}

# ---- 2. 演示数据（首次启动自动灌入，已有库则保留） ----
ensure_seed() {
  if [ ! -f data/travel.db ]; then
    echo "🌱 首次启动，写入演示数据…"
    npm run seed
  else
    echo "ℹ️  检测到 data/travel.db，保留现有数据（如需重置演示数据请运行 ./start.sh seed）"
  fi
}

case "$MODE" in
  seed)
    npm run seed
    echo "✅ 演示数据已重置"
    ;;

  dev)
    install_deps
    ensure_seed
    echo "🚀 开发模式启动：API http://localhost:4000 ｜ 前端 http://localhost:5173"
    exec npm run dev
    ;;

  prod|"")
    install_deps
    ensure_seed
    echo "🏗  构建前端…"
    npm run build
    echo "🚀 生产模式启动：http://localhost:${PORT}（Ctrl+C 停止）"
    PORT="$PORT" exec npm start
    ;;

  *)
    echo "用法：./start.sh [prod|dev|seed]"; exit 1
    ;;
esac
