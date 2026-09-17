# 豆包工作皮肤 - Windows 安装脚本
# 仅使用 Windows 自带工具（PowerShell），不依赖系统 Node.js、Git 或开发工具。

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
$dataRoot = if ($env:DWS_STATE_ROOT) { $env:DWS_STATE_ROOT } else { Join-Path $localAppData "DoubaoWorkSkin" }
$runtimeVersion = "24.21.0"
$runtimeArch = "win-x64"
$archiveName = "node-v${runtimeVersion}-${runtimeArch}.zip"
$downloadsDir = Join-Path $dataRoot "downloads"
$archivePath = Join-Path $downloadsDir $archiveName

# 检查豆包工作是否安装
$doubaoPaths = @(
    (Join-Path $localAppData "Programs\DoubaoWork\DoubaoWork.exe"),
    (Join-Path $env:ProgramFiles "DoubaoWork\DoubaoWork.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "DoubaoWork\DoubaoWork.exe")
)
$doubaoInstalled = $false
foreach ($p in $doubaoPaths) {
    if (Test-Path $p) { $doubaoInstalled = $true; break }
}
# 也检查 Store 版
if (-not $doubaoInstalled) {
    $storePkg = Get-AppxPackage | Where-Object { $_.Name -match "Doubao|春田" } | Select-Object -First 1
    if ($storePkg) { $doubaoInstalled = $true }
}
if (-not $doubaoInstalled) {
    Write-Error "请先安装豆包工作，再双击此文件。"
    exit 1
}

# 创建目录
New-Item -ItemType Directory -Force -Path $downloadsDir | Out-Null

$tempDir = Join-Path $downloadsDir ("install." + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
    # 下载 Node.js（如果缓存不存在）
    if (-not (Test-Path $archivePath)) {
        Write-Host "首次安装：正在下载专用运行环境（约 30 MB），不修改系统环境..."
        $url = "https://nodejs.org/dist/v${runtimeVersion}/${archiveName}"
        $tempArchive = Join-Path $tempDir "runtime.zip"
        Invoke-WebRequest -Uri $url -OutFile $tempArchive -UseBasicParsing -TimeoutSec 600

        # 从官方 SHASUMS256.txt 校验
        $shaUrl = "https://nodejs.org/dist/v${runtimeVersion}/SHASUMS256.txt"
        $shaText = (Invoke-WebRequest -Uri $shaUrl -UseBasicParsing -TimeoutSec 30).Content
        $expectedSha = ($shaText -split "`n" | Where-Object { $_ -match [regex]::Escape($archiveName) } | ForEach-Object { ($_ -split "\s+")[0] })
        if (-not $expectedSha) {
            Write-Error "无法获取官方校验值，未运行下载内容。请重试。"
            exit 1
        }
        $actualSha = (Get-FileHash $tempArchive -Algorithm SHA256).Hash.ToLower()
        if ($actualSha -ne $expectedSha.ToLower()) {
            Write-Error "下载校验失败，未运行下载内容。请重试。"
            exit 1
        }
        Move-Item $tempArchive $archivePath
    }

    # 校验缓存
    $shaUrl = "https://nodejs.org/dist/v${runtimeVersion}/SHASUMS256.txt"
    $shaText = (Invoke-WebRequest -Uri $shaUrl -UseBasicParsing -TimeoutSec 30).Content
    $expectedSha = ($shaText -split "`n" | Where-Object { $_ -match [regex]::Escape($archiveName) } | ForEach-Object { ($_ -split "\s+")[0] })
    $actualSha = (Get-FileHash $archivePath -Algorithm SHA256).Hash.ToLower()
    if ($actualSha -ne $expectedSha.ToLower()) {
        Write-Error "缓存校验失败，未运行。请删除此文件后重试：$archivePath"
        exit 1
    }

    # 解压
    $runtimeDir = Join-Path $tempDir "node-v${runtimeVersion}-${runtimeArch}"
    Expand-Archive -Path $archivePath -DestinationPath $tempDir -Force

    # 运行安装
    $env:DWS_STATE_ROOT = $dataRoot
    $nodeExe = Join-Path $runtimeDir "node.exe"
    & $nodeExe (Join-Path $projectRoot "scripts\install.mjs") --runtime-dir $runtimeDir
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host ""
    Write-Host "安装完成。请保存工作，等 Agent 当前任务结束，再双击桌面""豆包工作皮肤""里的""启动豆包工作.cmd""。"
} finally {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
}
