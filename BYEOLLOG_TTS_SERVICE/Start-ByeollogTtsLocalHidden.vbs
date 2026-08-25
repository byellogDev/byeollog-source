Option Explicit

Dim fileSystem, shell, scriptDirectory, startupScript, powerShellPath, command, exitCode
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
startupScript = fileSystem.BuildPath(scriptDirectory, "Start-ByeollogTtsLocal.ps1")
powerShellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = Chr(34) & powerShellPath & Chr(34) & _
    " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & _
    Chr(34) & startupScript & Chr(34)

' wscript.exe is a GUI-subsystem host. Window style 0 prevents a console from
' being created or flashed while the periodic repair script runs.
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
