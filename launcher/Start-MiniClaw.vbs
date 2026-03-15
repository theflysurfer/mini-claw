' Start-MiniClaw.vbs — Launch PowerShell tray app with no visible window
' Place a shortcut to this file in shell:startup for auto-start

Dim scriptDir, ps1Path
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
ps1Path = scriptDir & "\Start-MiniClaw.ps1"

Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1Path & """", 0, False
