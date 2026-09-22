#!/usr/bin/env bash
# ============================================================
# 旅行社组团与计调操作平台 · 一键启动
#
# 用法：
#   ./start.sh           生产模式：装依赖 →（缺库则写演示数据）→ 构建前端 → 启动 http://localhost:4000
#   ./start.sh --dev     开发模式：API(4000) + 前端热更新(5173)
#   ./start.sh --seed    强制重置演示数据后启动（生产模式）
#   ./start.sh --test    只运行测试（库存冲突/并发/预警中心）
# ============================================================
set -e
cd "$(dirname "$0")"

MODE=prod
FORCE_SEED=0
for arg in "$@"; do
  case "$arg" in
    --dev)  MODE=dev ;;
    --seed) FORCE_SEED=1 ;;
    --test) MODE=test ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg（用 --help 查看用法）"; exit 1 ;;
  esac
done

echo "==> [1/4] 检查依赖"
if [ ! -d node_modules ] || [ ! -d client/node_modules ]; then
  npm run install:all
else
  echo "    依赖已就绪，跳过安装"
fi

if [ "$MODE" = "test" ]; then
  echo "==> 运行测试"
  exec npm test
fi

DB_FILE="${TRAVEL_DB_FILE:-$(pwd)/data/travel.db}"
echo "==> [2/4] 检查演示数据"
if [ "$FORCE_SEED" = "1" ] || [ ! -f "$DB_FILE" ]; then
  npm run seed
else
  echo "    数据库已存在（$DB_FILE），跳过；如需重置演示数据请用 ./start.sh --seed"
fi

if [ "$MODE" = "dev" ]; then
  echo "==> [3/4] 开发模式启动（API :4000 / 前端热更新 :5173）"
  exec npm run dev
fi

echo "==> [3/4] 构建前端"
npm run build

echo "==> [4/4] 启动服务"
echo "    访问 http://localhost:4000 （预警中心：#/alerts）"
exec npm start
