' Starts the ChatLens sync agent with no window. A shortcut to this file sits in
' the Startup folder so it runs at logon. Log: %LOCALAPPDATA%\ChatLens\sync.log
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
node = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node"
CreateObject("WScript.Shell").Run """" & node & """ """ & here & "\chatlens-sync.mjs""", 0, False
