# Mini-Claw Launcher — System Tray with invisible window
# Starts node dist/index.js, shows tray icon, offers Restart/Logs/Stop

param(
    [string]$BotDir = ""
)

# Resolve paths
$LauncherDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $BotDir) {
    $BotDir = Split-Path -Parent $LauncherDir  # launcher/ is inside mini-claw/
}
# Resolve to absolute path
$BotDir = (Resolve-Path $BotDir).Path
$IconPath = Join-Path $LauncherDir "mini-claw.ico"
$LogDir = Join-Path $env:USERPROFILE ".mini-claw\logs"
$LogFile = Join-Path $LogDir "mini-claw.log"
$PidFile = Join-Path $env:USERPROFILE ".mini-claw\bot.pid"

# ---------------------------------------------------------------------------
# Tray icon setup
# ---------------------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Validate
if (-not (Test-Path (Join-Path $BotDir "dist\index.js"))) {
    [System.Windows.Forms.MessageBox]::Show("dist\index.js not found in:`n$BotDir", "Mini-Claw Error") | Out-Null
    exit 1
}

[System.Windows.Forms.Application]::EnableVisualStyles()

$script:botProcess = $null

# Create notify icon
$tray = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $IconPath) {
    $tray.Icon = New-Object System.Drawing.Icon($IconPath)
} else {
    $tray.Icon = [System.Drawing.SystemIcons]::Application
}
$tray.Text = "Mini-Claw (starting...)"
$tray.Visible = $true

# Context menu
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$statusItem = $menu.Items.Add("Starting...") | Out-Null
$statusItem = $menu.Items[0]
$statusItem.Enabled = $false

$menu.Items.Add("-") | Out-Null

$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Restart Bot")
$menu.Items.Add($restartItem) | Out-Null

$logsItem = New-Object System.Windows.Forms.ToolStripMenuItem("Open Logs")
$menu.Items.Add($logsItem) | Out-Null

$logFolderItem = New-Object System.Windows.Forms.ToolStripMenuItem("Open Log Folder")
$menu.Items.Add($logFolderItem) | Out-Null

$projectItem = New-Object System.Windows.Forms.ToolStripMenuItem("Open Project Folder")
$menu.Items.Add($projectItem) | Out-Null

$menu.Items.Add("-") | Out-Null

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem("Stop and Exit")
$menu.Items.Add($exitItem) | Out-Null

$tray.ContextMenuStrip = $menu

# ---------------------------------------------------------------------------
# Bot process management
# ---------------------------------------------------------------------------
function Start-Bot {
    if ($script:botProcess -and !$script:botProcess.HasExited) {
        Stop-Bot
    }

    $tray.Text = "Mini-Claw (starting...)"
    $statusItem.Text = "Starting..."

    # Find node.exe explicitly
    $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodePath) {
        $nodePath = "C:\Program Files\nodejs\node.exe"
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodePath
    $psi.Arguments = "dist/index.js"
    $psi.WorkingDirectory = $BotDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $false

    try {
        $script:botProcess = [System.Diagnostics.Process]::Start($psi)

        # Save PID
        New-Item -ItemType Directory -Force -Path (Split-Path $PidFile) | Out-Null
        $script:botProcess.Id | Out-File -FilePath $PidFile -Force

        $tray.Text = "Mini-Claw (PID $($script:botProcess.Id))"
        $statusItem.Text = "Running (PID $($script:botProcess.Id))"
        $tray.ShowBalloonTip(2000, "Mini-Claw", "Bot started (PID $($script:botProcess.Id))", [System.Windows.Forms.ToolTipIcon]::Info)
    } catch {
        $statusItem.Text = "Failed to start"
        $tray.ShowBalloonTip(3000, "Mini-Claw", "Failed: $_", [System.Windows.Forms.ToolTipIcon]::Error)
    }
}

function Stop-Bot {
    if ($script:botProcess -and !$script:botProcess.HasExited) {
        try {
            $script:botProcess.Kill()
            $script:botProcess.WaitForExit(5000)
        } catch {}
    }
    $script:botProcess = $null
    $statusItem.Text = "Stopped"
    $tray.Text = "Mini-Claw (stopped)"
}

# ---------------------------------------------------------------------------
# Health check timer — detect crashes, auto-restart
# ---------------------------------------------------------------------------
$healthTimer = New-Object System.Windows.Forms.Timer
$healthTimer.Interval = 10000  # 10s
$healthTimer.Add_Tick({
    if ($script:botProcess -and $script:botProcess.HasExited) {
        $exitCode = $script:botProcess.ExitCode
        $statusItem.Text = "Crashed (exit $exitCode) — restarting..."
        $tray.Text = "Mini-Claw (crashed)"
        $tray.ShowBalloonTip(3000, "Mini-Claw", "Crashed (exit $exitCode). Auto-restarting...", [System.Windows.Forms.ToolTipIcon]::Warning)
        $script:botProcess = $null
        Start-Sleep -Seconds 3
        Start-Bot
    }
})
$healthTimer.Start()

# ---------------------------------------------------------------------------
# Event handlers
# ---------------------------------------------------------------------------
$restartItem.Add_Click({
    $tray.ShowBalloonTip(1000, "Mini-Claw", "Restarting...", [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Bot
})

$logsItem.Add_Click({
    if (Test-Path $LogFile) {
        Start-Process "notepad.exe" -ArgumentList "`"$LogFile`""
    } else {
        $tray.ShowBalloonTip(2000, "Mini-Claw", "No log file yet", [System.Windows.Forms.ToolTipIcon]::Warning)
    }
})

$logFolderItem.Add_Click({
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    Start-Process "explorer.exe" -ArgumentList "`"$LogDir`""
})

$projectItem.Add_Click({
    Start-Process "explorer.exe" -ArgumentList "`"$BotDir`""
})

$exitItem.Add_Click({
    Stop-Bot
    $healthTimer.Stop()
    $tray.Visible = $false
    $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

# Double-click tray icon -> open logs
$tray.Add_DoubleClick({
    if (Test-Path $LogFile) {
        Start-Process "notepad.exe" -ArgumentList "`"$LogFile`""
    }
})

# ---------------------------------------------------------------------------
# Start bot and run message loop
# ---------------------------------------------------------------------------
Start-Bot
[System.Windows.Forms.Application]::Run()
