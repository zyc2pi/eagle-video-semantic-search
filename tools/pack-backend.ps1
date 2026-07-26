# 视频语义搜索插件 —— 后端分发打包脚本
#
# 用法（PowerShell）:
#   .\pack-backend.ps1                          # 最小包：FG-CLIP2 + ffmpeg（约 7~8 GB）
#   .\pack-backend.ps1 -IncludeCLIP             # 附带 openai-clip 模型（英文搜索）
#   .\pack-backend.ps1 -IncludeMiniCPM          # 附带 MiniCPM 精搜模型（+2.5 GB）
#   .\pack-backend.ps1 -Zip                     # 完成后压缩为 zip
#   .\pack-backend.ps1 -DryRun                  # 只列出会复制什么，不实际复制
#
# 产物结构:
#   <Dest>\
#     backend\        Python 服务（接收方可放到任意路径）
#     安装说明.md      给接收方看的安装步骤

param(
    [string]$Source = 'D:\Auto-scenes-extraction-1.3.0\Auto-scenes-extraction-1.3.0',
    [string]$Dest = 'D:\VideoSemanticSearch-dist',
    [switch]$IncludeCLIP,
    [switch]$IncludeMiniCPM,
    [switch]$Zip,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path (Join-Path $Source 'text_search.py'))) {
    Write-Error "源目录不对：$Source 下找不到 text_search.py"
}

$backend = Join-Path $Dest 'backend'
$listOnly = if ($DryRun) { '/L' } else { $null }

function Invoke-Robocopy {
    param([string]$From, [string]$To, [string[]]$Extra = @())
    $args = @($From, $To, '/E', '/NFL', '/NDL', '/NJH') + $Extra
    if ($listOnly) { $args += $listOnly }
    & robocopy @args
    if ($LASTEXITCODE -ge 8) { Write-Error "robocopy 失败 ($LASTEXITCODE): $From" }
}

Write-Host "== 1/4 复制服务主体（排除 索引/临时/导出/全部模型）=="
# indexes/temp/output 是运行时产物；models 单独选择性复制；排除缓存与仓库元数据
Invoke-Robocopy $Source $backend @(
    '/XD', 'indexes', 'temp', 'output', 'models', '__pycache__', '.git',
    '/XF', '*.pyc'
)

Write-Host "== 2/4 复制必需模型：ffmpeg + FG-CLIP2 =="
Invoke-Robocopy (Join-Path $Source 'models\ffmpeg') (Join-Path $backend 'models\ffmpeg')
Invoke-Robocopy (Join-Path $Source 'models\qihoo360-fg-clip2-base') (Join-Path $backend 'models\qihoo360-fg-clip2-base')

if ($IncludeCLIP) {
    Write-Host "== 复制 openai-clip（剔除冗余权重，只留 safetensors）=="
    Invoke-Robocopy (Join-Path $Source 'models\openai-clip-vit-large-patch14') `
        (Join-Path $backend 'models\openai-clip-vit-large-patch14') `
        @('/XF', 'pytorch_model.bin', 'tf_model.h5', 'flax_model.msgpack')
}

if ($IncludeMiniCPM) {
    Write-Host "== 复制 MiniCPM-V-4-6（二阶段精搜用）=="
    Invoke-Robocopy (Join-Path $Source 'models\MiniCPM-V-4-6') (Join-Path $backend 'models\MiniCPM-V-4-6')
}

Write-Host "== 3/4 复制安装说明 =="
$installDoc = Join-Path $PSScriptRoot '..\安装说明.md'
if ((Test-Path $installDoc) -and -not $DryRun) {
    Copy-Item $installDoc (Join-Path $Dest '安装说明.md') -Force
}

if (-not $DryRun) {
    $size = (Get-ChildItem $Dest -Recurse -File | Measure-Object Length -Sum).Sum / 1GB
    Write-Host ("== 4/4 完成，总大小 {0:N1} GB，输出目录: {1} ==" -f $size, $Dest)
    if ($Zip) {
        $zipPath = "$Dest.zip"
        Write-Host "== 压缩到 $zipPath（较慢）=="
        Compress-Archive -Path "$Dest\*" -DestinationPath $zipPath -Force
        Write-Host "== 压缩完成 =="
    }
} else {
    Write-Host '== DryRun 结束（未实际复制）=='
}

# robocopy 的退出码 1~7 表示"有文件被复制"等正常情况，避免让脚本整体看起来失败
exit 0
