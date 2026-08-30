Option Explicit

Function Quote(ByVal value)
  Quote = Chr(34) & CStr(value) & Chr(34)
End Function

If WScript.Arguments.Count < 1 Then
  WScript.Quit 64
End If

Dim shell, powerShellPath, scriptPath, command
Set shell = CreateObject("WScript.Shell")
powerShellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
scriptPath = WScript.Arguments(0)
command = Quote(powerShellPath) & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Quote(scriptPath)

WScript.Quit shell.Run(command, 0, True)
