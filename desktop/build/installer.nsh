!macro deleteDownanyProtocolIfOwned ROOT_KEY
  ReadRegStr $0 ${ROOT_KEY} "Software\Classes\downany\shell\open\command" ""
  StrCpy $1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  ${If} $0 == $1
    DeleteRegKey ${ROOT_KEY} "Software\Classes\downany"
  ${EndIf}
!macroend

!macro customUnInstall
  !insertmacro deleteDownanyProtocolIfOwned SHELL_CONTEXT
  !insertmacro deleteDownanyProtocolIfOwned HKCU
  SetOutPath "$TEMP"
  RMDir "$INSTDIR"
!macroend
