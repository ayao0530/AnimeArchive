' ============================================================
'  Anime Archive Helper - create a desktop shortcut (optional)
'  Double-click this file once.
'  Keep this file ASCII-only.
' ============================================================
Option Explicit
Dim fso, sh, scriptDir, serverDir, desktop, lnk, target, icon

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverDir = fso.GetParentFolderName(scriptDir)
desktop   = sh.SpecialFolders("Desktop")
target    = scriptDir & "\start.vbs"
icon      = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\shell32.dll,137"

Set lnk = sh.CreateShortcut(desktop & "\AnimeArchiveHelper.lnk")
lnk.TargetPath       = "wscript.exe"
lnk.Arguments        = """" & target & """"
lnk.WorkingDirectory = serverDir
lnk.IconLocation     = icon
lnk.Description      = "Start Anime Archive Helper (local service 127.0.0.1:9999)"
lnk.Save

MsgBox "Desktop shortcut created: AnimeArchiveHelper.lnk" & vbCrLf & vbCrLf & "Double-click it to start the service and open the browser.", 64, "Anime Archive Helper"
