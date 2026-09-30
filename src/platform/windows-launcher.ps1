# Generated desktop entry. Do not run from an Agent hosted by Doubao Work.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$dataRoot = '@@DATA_ROOT@@'
$node = Join-Path $dataRoot 'engine\runtime\node.exe'
$bridge = Join-Path $dataRoot 'engine\scripts\installed-cli.mjs'
$log = if ($env:DWS_LAUNCHER_LOG) { $env:DWS_LAUNCHER_LOG } else { Join-Path $dataRoot 'launcher.log' }
$mutexName = if ($env:DWS_LAUNCHER_MUTEX) { $env:DWS_LAUNCHER_MUTEX } else { '@@MUTEX_NAME@@' }
$env:DWS_STATE_ROOT = $dataRoot
# Match skin.cmd: inherited Node hooks must not execute in our private runtime.
Remove-Item Env:NODE_OPTIONS, Env:NODE_PATH -ErrorAction Ignore

$script:logUnavailable = $false
function Write-Log([string]$Message) {
    if ($script:logUnavailable) { return }
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        try {
            $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message
            Add-Content -LiteralPath $log -Value $line -Encoding UTF8 -ErrorAction Stop
            return
        } catch {
            if ($attempt -lt 3) { Start-Sleep -Milliseconds 50 }
        }
    }
    $script:logUnavailable = $true
}

function Show-Failure([string]$Message) {
    if ($env:DWS_LAUNCHER_NO_UI) { return }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        ($Message + [Environment]::NewLine + '日志：' + $log), '豆包工作皮肤',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}

function Invoke-Skin {
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw '专用 Node.js 不存在，请重新运行安装器。' }
    if (-not (Test-Path -LiteralPath $bridge -PathType Leaf)) { throw '换肤程序入口不存在，请重新运行安装器。' }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $node
    # Windows file paths cannot contain a double quote. Pass no shell or user arguments.
    $info.Arguments = '"' + $bridge + '" start --force'
    $info.WorkingDirectory = $dataRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $info
    try {
        if (-not $child.Start()) { throw '无法启动换肤程序。' }
        # Drain both pipes asynchronously: no deadlock and no PowerShell 5.1
        # NativeCommandError conversion. Waiting on the tasks includes EOF, so
        # final stdout and stderr are flushed before reporting the exit code.
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        $child.WaitForExit()
        foreach ($text in @($stdout.Result, $stderr.Result)) {
            foreach ($line in ($text -split '\r?\n')) { if ($line) { Write-Log $line } }
        }
        return $child.ExitCode
    } finally { $child.Dispose() }
}

function Activate-DoubaoWork {
    try {
        $statePath = Join-Path $dataRoot 'state.json'
        if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { Write-Log '换肤成功，但没有状态文件可用于恢复窗口'; return }
        $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $appPid = [int]$state.doubaoWorkPid
        if ($appPid -le 0) { Write-Log '换肤成功，但状态中没有主进程 PID'; return }
        # Reject stale/reused PIDs before touching a window. Never activate by title substring.
        $app = Get-Process -Id $appPid -ErrorAction Stop
        if ($app.ProcessName -ne 'DoubaoWork') { Write-Log '换肤成功，但状态 PID 不再属于豆包工作'; return }
        Add-Type -TypeDefinition @'
@@WINDOW_SOURCE@@
'@
        for ($attempt = 0; $attempt -lt 15; $attempt++) {
            $result = [DoubaoWorkSkin.WindowActivation]::TryActivate($appPid)
            if ($result -eq 'foreground') { Write-Log ('已恢复并置前豆包工作 PID ' + $appPid); return }
            Start-Sleep -Milliseconds 200
        }
        Write-Log ('换肤成功，窗口置前未确认（' + $result + '）；可点击任务栏打开豆包工作')
    } catch { Write-Log ('换肤成功，但窗口恢复失败：' + $_.Exception.Message) }
}

$mutex = $null
$acquired = $false
$exitCode = 1
try {
    $mutex = New-Object System.Threading.Mutex($false, $mutexName)
    try { $acquired = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) {
        $exitCode = 0
        Write-Log '已有启动器在运行，静默退出'
    } else {
        Write-Log '桌面入口：直接 start --force'
        $exitCode = Invoke-Skin
        Write-Log ('force exit=' + $exitCode)
        if ($exitCode -eq 0) { Activate-DoubaoWork }
        else {
            Write-Log ('失败 code=' + $exitCode)
            Show-Failure ('豆包工作皮肤启动失败（错误码 ' + $exitCode + '）。')
        }
    }
} catch {
    $message = '启动器异常：' + $_.Exception.Message
    Write-Log $message
    if ($exitCode -ne 0) { try { Show-Failure $message } catch {} }
} finally {
    if ($acquired) {
        Write-Log 'launcher completed'
        try { $mutex.ReleaseMutex() } catch {}
    }
    if ($null -ne $mutex) { try { $mutex.Dispose() } catch {} }
}
exit $exitCode
