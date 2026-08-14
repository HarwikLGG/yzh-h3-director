# dsh-vision-bridge 一键安装脚本（Windows PowerShell）
# 用法: powershell -ExecutionPolicy Bypass -File install.ps1          （默认装入 web profile）
#       powershell -ExecutionPolicy Bypass -File install.ps1 -Profile headless
param(
    [string]$Profile = "web"
)
$ErrorActionPreference = "Stop"

$PluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }

Write-Host "==> 1/4 检查 dsh"
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) {
    Write-Host "错误: 未找到 dsh 命令。请先安装 dsh（npm install -g @deepseek-ai/dsh）并确认它在 PATH 中。" -ForegroundColor Red
    exit 1
}
Write-Host "    dsh: $($dsh.Source)"

Write-Host "==> 2/4 准备 pnpm（dsh plugin 依赖 pnpm 转发）"
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$PnpmPathEnv = $null
if (-not $pnpm) {
    $corepack = Get-Command corepack -ErrorAction SilentlyContinue
    if (-not $corepack) {
        Write-Host "错误: 未找到 pnpm 或 corepack。请安装 Node.js >= 20（自带 corepack）或单独安装 pnpm。" -ForegroundColor Red
        exit 1
    }
    # 用 corepack 包装一个临时 pnpm.cmd，dsh 内部 spawn("pnpm") 按 PATHEXT 可找到
    $PnpmPathEnv = Join-Path $env:TEMP "dsh-pnpm-bin"
    New-Item -ItemType Directory -Force -Path $PnpmPathEnv | Out-Null
    Set-Content -Path (Join-Path $PnpmPathEnv "pnpm.cmd") -Value "@echo off`r`ncorepack pnpm %*"
    Write-Host "    使用 corepack 包装 pnpm: $PnpmPathEnv\pnpm.cmd"
} else {
    Write-Host "    使用系统 pnpm: $($pnpm.Source)"
}

Write-Host "==> 3/4 安装插件到 profile '$Profile'"
if ($PnpmPathEnv) {
    $oldPath = $env:PATH
    $env:PATH = "$PnpmPathEnv;$oldPath"
}
& $dsh.Source plugin --profile $Profile add $PluginDir
if ($LASTEXITCODE -ne 0) {
    Write-Host "安装失败（dsh plugin 退出码 $LASTEXITCODE）" -ForegroundColor Red
    exit $LASTEXITCODE
}
if ($PnpmPathEnv) { $env:PATH = $oldPath }

Write-Host "==> 4/4 链接运行时依赖（Junction 不需要管理员权限）"
$linkTarget = Join-Path $PluginDir "node_modules"
$linked = $false
$candidates = @(
    (Join-Path $DshHome "profiles\$Profile\node_modules"),
    (Join-Path $DshHome "profiles\node_modules")
)
foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c "@deepseek-ai")) {
        if (Test-Path $linkTarget) {
            # 可能是上次的 junction 或目录：先移除再重建
            Remove-Item $linkTarget -Recurse -Force -ErrorAction SilentlyContinue
        }
        New-Item -ItemType Junction -Path $linkTarget -Target $c | Out-Null
        Write-Host "    已链接: $linkTarget -> $c"
        $linked = $true
        break
    }
}
if (-not $linked) {
    Write-Host "    警告: 未找到 hoisted 依赖目录。请手动把 profile 的 node_modules 链接到: $linkTarget" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=============================================================="
Write-Host "✅ 安装完成！接下来："
Write-Host ""
Write-Host "  1) 配置视觉模型（二选一）"
Write-Host "     a) 编辑 $DshHome\profiles\$Profile\cordis.patch.yml，按 README.md 示例覆盖 vision-bridge 行；"
Write-Host "     b) 或先启动，再到 设置 → 插件 → vision-bridge 卡片填写（保存即生效）"
Write-Host ""
Write-Host "  2) 重启生效：dsh web"
Write-Host ""
Write-Host "  3) 大图缩小依赖 sharp（Windows/Linux）或 sips（仅 macOS）。"
Write-Host "     若 sharp 未随安装装上，请手动安装："
Write-Host "     cd $DshHome\profiles\$Profile; pnpm install sharp"
Write-Host "=============================================================="
