#!/bin/bash
# dsh-vision-bridge 一键安装脚本（新机器 / 新 dsh web 环境）
# 用法: bash install.sh [profile名]   （默认 profile 为 web）
set -e

PROFILE="${1:-web}"
DSH_BIN="${DSH_BIN:-dsh}"
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

echo "==> 1/4 检查 dsh"
if ! command -v "$DSH_BIN" >/dev/null 2>&1; then
  echo "错误: 找不到命令 '$DSH_BIN'。请先安装 dsh 并确保它在 PATH 中。"
  exit 1
fi
echo "    dsh: $(command -v "$DSH_BIN")"

echo "==> 2/4 准备 pnpm（dsh plugin 依赖 pnpm 转发）"
PNPM_BIN_DIR=""
if command -v pnpm >/dev/null 2>&1; then
  echo "    使用系统 pnpm: $(command -v pnpm)"
else
  if ! command -v corepack >/dev/null 2>&1; then
    echo "错误: 未找到 pnpm 或 corepack，无法安装插件。"
    exit 1
  fi
  PNPM_BIN_DIR="$(mktemp -d)/bin"
  mkdir -p "$PNPM_BIN_DIR"
  printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > "$PNPM_BIN_DIR/pnpm"
  chmod +x "$PNPM_BIN_DIR/pnpm"
  echo "    使用 corepack 包装 pnpm: $PNPM_BIN_DIR/pnpm"
fi

echo "==> 3/4 安装插件到 profile '${PROFILE}'"
if [ -n "$PNPM_BIN_DIR" ]; then
  PATH="$PNPM_BIN_DIR:$PATH" "$DSH_BIN" plugin --profile "$PROFILE" add "$PLUGIN_DIR"
else
  "$DSH_BIN" plugin --profile "$PROFILE" add "$PLUGIN_DIR"
fi

echo "==> 4/4 链接运行时依赖（插件从自身目录解析 @deepseek-ai/*）"
LINKED=0
for cand in "$DSH_HOME/profiles/$PROFILE/node_modules" "$DSH_HOME/profiles/node_modules"; do
  if [ -d "$cand/@deepseek-ai" ]; then
    ln -sfn "$cand" "$PLUGIN_DIR/node_modules"
    echo "    已链接: $PLUGIN_DIR/node_modules -> $cand"
    LINKED=1
    break
  fi
done
if [ "$LINKED" = "0" ]; then
  echo "    警告: 未找到 hoisted 依赖目录，插件可能在运行时无法解析依赖。"
  echo "    请手动把 profile 的 node_modules 链接到: $PLUGIN_DIR/node_modules"
fi

echo "==> 5/5 检查大图缩小后端（sharp / sips）"
SCALE_OK=0
if [ -e "$PLUGIN_DIR/node_modules/sharp" ]; then
  echo "    sharp: ✓ 可用（Windows/Linux/macOS 通用，大图缩小首选）"
  SCALE_OK=1
elif command -v sips >/dev/null 2>&1; then
  echo "    sips: ✓ 可用（仅 macOS 原生，sharp 缺失时兜底）"
  SCALE_OK=1
else
  echo "    ✗ sharp 与 sips 均不可用：大图将不会被缩小，超大图片可能被视觉服务端拒绝。"
  echo "      请手动安装 sharp：cd \"$DSH_HOME/profiles/$PROFILE\" && pnpm install sharp"
fi

echo
echo "=============================================================="
echo "✅ 安装完成！接下来："
echo ""
echo "  1) 配置视觉模型（二选一）"
echo "     a) 编辑 $DSH_HOME/profiles/$PROFILE/cordis.patch.yml，"
echo "        按 README.md 的示例覆盖 vision-bridge 行；"
echo "     b) 或先启动，再到 设置 → 插件 → vision-bridge 卡片填写"
echo "        （baseURL / model / apiKeyEnv，保存即生效）"
echo ""
echo "  2) 重启生效：$DSH_BIN web"
echo ""
echo "  3) 验证：发一张带文字的图片，回复里应出现"
echo "     '[图片名 的内容描述（由视觉模型 xxx 生成）]'"
echo "=============================================================="
