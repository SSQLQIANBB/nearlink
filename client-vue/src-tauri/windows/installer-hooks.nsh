; alpha.10 could leave empty NVIDIA driver log directories in the engine bundle.
; Remove only those empty directories. Never recursively delete files or follow
; an installation/resource-directory junction during this migration.
!include "LogicLib.nsh"

!macro NSIS_HOOK_PREINSTALL
  Push $0
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\remote-control-engine") i .r0'
  IntOp $0 $0 & 0x400
  ${If} $0 == 0
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\remote-control-engine\NVIDIA Corporation") i .r0'
    IntOp $0 $0 & 0x400
    ${If} $0 == 0
      RMDir "$INSTDIR\remote-control-engine\NVIDIA Corporation\umdlogs"
      RMDir "$INSTDIR\remote-control-engine\NVIDIA Corporation"
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $0
!macroend
