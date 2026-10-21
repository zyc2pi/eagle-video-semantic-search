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
$sourceAbsolute = [IO.Path]::GetFullPath($Source).TrimEnd('\')
$destAbsolute = [IO.Path]::GetFullPath($Dest).TrimEnd('\')
if ($destAbsolute -eq $sourceAbsolute -or
    $destAbsolute.StartsWith($sourceAbsolute + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $sourceAbsolute.StartsWith($destAbsolute + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw '源后端与分发目录不能相同或相互包含，避免打包个人数据或覆盖本机配置'
}
$defaultConfig = Join-Path $PSScriptRoot 'backend-config.template.json'
if (-not (Test-Path -LiteralPath $defaultConfig)) {
    throw '缺少无凭据的后端默认配置模板'
}
if (Test-Path -LiteralPath $backend) {
    $sensitiveFiles = @(Get-ChildItem -LiteralPath $backend -File | Where-Object {
        $_.Name -like 'config.json.*' -or $_.Name -like 'service.log*'
    })
    if ((Test-Path -LiteralPath (Join-Path $backend 'state')) -or $sensitiveFiles.Count) {
        throw '分发目录含旧服务凭据、配置备份或日志，请改用空的 Dest；为保护原数据，未删除残留文件'
    }
    $existingConfig = Join-Path $backend 'config.json'
    if ((Test-Path -LiteralPath $existingConfig) -and
        (Get-FileHash -LiteralPath $existingConfig -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $defaultConfig -Algorithm SHA256).Hash) {
        throw '分发目录已有非默认配置，请改用空的 Dest；未输出或覆盖其配置内容'
    }
}
$listOnly = if ($DryRun) { '/L' } else { $null }

function Invoke-Robocopy {
    param([string]$From, [string]$To, [string[]]$Extra = @())
    $args = @($From, $To, '/E', '/NFL', '/NDL', '/NJH') + $Extra
    if ($listOnly) { $args += $listOnly }
    & robocopy @args
    if ($LASTEXITCODE -ge 8) { Write-Error "robocopy 失败 ($LASTEXITCODE): $From" }
}

Write-Host "== 1/4 复制服务主体（排除 索引/临时/导出/全部模型）=="
# state 包含本机服务控制凭据；config/备份可能含 API key，不能随分发包复制
Invoke-Robocopy $Source $backend @(
    '/XD', 'indexes', 'temp', 'output', 'models', '__pycache__', '.git', (Join-Path $Source 'state'),
    '/XF', '*.pyc', (Join-Path $Source 'config.json'), (Join-Path $Source 'config.json.*'),
    (Join-Path $Source 'service.log'), (Join-Path $Source 'service.log.*')
)
if ($DryRun) {
    Write-Host '分发配置：使用固定默认模板，不复制本机 API key 或配置备份'
} else {
    Copy-Item -LiteralPath $defaultConfig -Destination (Join-Path $backend 'config.json') -Force
}

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
