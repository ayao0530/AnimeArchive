' ============================================================
'  Anime Archive Helper - one-click start (no console window)
'  Double-click this file: starts the local service hidden
'  (127.0.0.1:9999) and opens the browser.
'
'  NOTE: keep this file ASCII-only. cscript parses .vbs using the
'  system ANSI codepage, so UTF-8 Chinese text would break parsing.
' ============================================================
Option Explicit

Dim fso, sh, scriptDir, serverDir, projectDir, nodeExe, entry, toolsDir

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir  = fso.GetParentFolderName(WScript.ScriptFullName)
serverDir  = fso.GetParentFolderName(scriptDir)
projectDir = fso.GetParentFolderName(serverDir)

entry = serverDir & "\dist\index.js"
If Not fso.FileExists(entry) Then
  MsgBox "Build output not found:" & vbCrLf & entry & vbCrLf & vbCrLf & "Run these first inside the server folder:" & vbCrLf & "    npm install" & vbCrLf & "    npm run build", 16, "Anime Archive Helper"
  WScript.Quit 1
End If

nodeExe = ResolveNode(serverDir, projectDir, toolsDir)
If nodeExe = "" Then
  MsgBox "Node.js 18+ was not found." & vbCrLf & vbCrLf & "Install Node.js (https://nodejs.org), or unzip a portable build into:" & vbCrLf & projectDir & "\.tools\node-*\", 16, "Anime Archive Helper"
  WScript.Quit 1
End If

sh.CurrentDirectory = serverDir

' If the service is already running, just open the browser.
' (Starting a second instance would silently move to port 9999+1 and the
'  browser would keep talking to the stale one.)
'
' NOTE: open the **site root** - /api/health is a JSON API, opening it just
' shows {"ok":true,...} instead of the app. It is only used as a probe here.
Dim siteUrl, healthUrl
siteUrl = "http://127.0.0.1:" & ReadPort(serverDir & "\data\config.json") & "/"
healthUrl = siteUrl & "api/health"
If AlreadyRunning(healthUrl) Then
  sh.Run siteUrl, 1, False
  WScript.Quit 0
End If

sh.Run """" & nodeExe & """ """ & entry & """", 0, False

' The service opens the browser itself once the port is ready.
WScript.Sleep 1500
WScript.Quit 0

' ---------- is the service already running? ----------
Function AlreadyRunning(url)
  Dim http
  AlreadyRunning = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", url, False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then AlreadyRunning = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

' ---------- read configured port ----------
Function ReadPort(cfgPath)
  Dim ts, txt, p, q, r, v
  ReadPort = 9999
  On Error Resume Next
  If Not fso.FileExists(cfgPath) Then Exit Function
  Set ts = fso.OpenTextFile(cfgPath, 1)
  txt = ts.ReadAll
  ts.Close
  p = InStr(txt, """port""")
  If p > 0 Then
    p = InStr(p, txt, ":")
    q = p + 1
    Do While q <= Len(txt) And Mid(txt, q, 1) = " "
      q = q + 1
    Loop
    r = q
    Do While r <= Len(txt) And IsNumeric(Mid(txt, r, 1))
      r = r + 1
    Loop
    v = Trim(Mid(txt, q, r - q))
    If IsNumeric(v) Then ReadPort = CLng(v)
  End If
  On Error GoTo 0
End Function

' ---------- locate node.exe ----------
Function ResolveNode(serverDir, projectDir, toolsDir)
  Dim cfgPath, folder, candidate, envPath, parts, i
  Dim common(3)

  ResolveNode = ""

  ' 1) explicit nodePath in server\data\config.json
  cfgPath = serverDir & "\data\config.json"
  If fso.FileExists(cfgPath) Then
    candidate = ReadNodePath(cfgPath)
    If candidate <> "" Then
      If fso.FileExists(candidate) Then
        ResolveNode = candidate
        Exit Function
      End If
    End If
  End If

  ' 2) bundled portable node under .tools\node-*
  toolsDir = projectDir & "\.tools"
  If fso.FolderExists(toolsDir) Then
    For Each folder In fso.GetFolder(toolsDir).SubFolders
      If LCase(Left(folder.Name, 5)) = "node-" Then
        candidate = folder.Path & "\node.exe"
        If fso.FileExists(candidate) Then
          ResolveNode = candidate
          Exit Function
        End If
      End If
    Next
  End If

  ' 3) node on PATH
  envPath = sh.ExpandEnvironmentStrings("%PATH%")
  parts = Split(envPath, ";")
  For i = 0 To UBound(parts)
    If parts(i) <> "" Then
      candidate = parts(i) & "\node.exe"
      If fso.FileExists(candidate) Then
        ResolveNode = candidate
        Exit Function
      End If
    End If
  Next

  ' 4) common install locations
  common(0) = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
  common(1) = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\node.exe"
  common(2) = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe"
  common(3) = sh.ExpandEnvironmentStrings("%APPDATA%") & "\npm\node.exe"
  For i = 0 To 3
    If fso.FileExists(common(i)) Then
      ResolveNode = common(i)
      Exit Function
    End If
  Next
End Function

' ---------- read nodePath from config.json ----------
Function ReadNodePath(cfgPath)
  Dim ts, txt, p, q, r
  ReadNodePath = ""
  On Error Resume Next
  Set ts = fso.OpenTextFile(cfgPath, 1)
  txt = ts.ReadAll
  ts.Close
  p = InStr(txt, """nodePath""")
  If p > 0 Then
    p = InStr(p, txt, ":")
    q = InStr(p, txt, """")
    If q > 0 Then
      r = InStr(q + 1, txt, """")
      If r > q Then
        ReadNodePath = Replace(Mid(txt, q + 1, r - q - 1), "\\", "\")
      End If
    End If
  End If
  On Error GoTo 0
End Function
