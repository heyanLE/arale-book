; Tauri CLI 2.12.1 emits an unquoted executable in APP_ASSOCIATE.
; Keep Tauri's association backup/uninstall logic and correct only our own classes
; after registration. Both the program and selected file must remain single arguments.
!macro ARALE_QUOTE_ASSOCIATION CLASS
  WriteRegStr SHCTX "Software\Classes\${CLASS}\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
  WriteRegStr SHCTX "Software\Classes\${CLASS}\DefaultIcon" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro ARALE_QUOTE_ASSOCIATION "ARaLeBook.TauriPreview.Epub"
  !insertmacro ARALE_QUOTE_ASSOCIATION "ARaLeBook.TauriPreview.Comic"
  !insertmacro ARALE_QUOTE_ASSOCIATION "ARaLeBook.TauriPreview.Mokuro"
  !insertmacro UPDATEFILEASSOC
!macroend
