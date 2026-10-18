Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"
!ifndef APP_NAME
 !define APP_NAME "Lake"
!endif
!ifndef UNINSTALL_KEY
 !define UNINSTALL_KEY "CleanLakes"
!endif
Var LakeUpdate
Name "${APP_NAME} ${VERSION} (Windows x86_64)"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
!ifdef DEV_BUILD
 SetCompressor /SOLID zlib
!else
 SetCompressor /SOLID lzma
!endif
VIProductVersion "${PRODUCT_VERSION}"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} Windows x86_64 installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright (c) Clean Lakes contributors"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Lake.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_PAGE_WELCOME
!define MUI_DIRECTORYPAGE_TEXT_TOP "$(LakeDirectoryText)"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
LangString LakeDirectoryText ${LANG_SIMPCHINESE} "保留默认位置即可直接安装，或点击“浏览”选择自定义安装目录。下次安装和自动更新会沿用此位置。"
LangString LakeDirectoryText ${LANG_ENGLISH} "Keep the default location, or click Browse to choose a custom installation folder. Future installations and updates will reuse this location."

Function .onInit
 StrCpy $LakeUpdate "0"
 ClearErrors
 ${GetOptions} $CMDLINE "/LAKEUPDATE" $0
 ${IfNot} ${Errors}
  StrCpy $LakeUpdate "1"
 ${EndIf}
 ${IfNot} ${RunningX64}
  MessageBox MB_ICONSTOP "此软件包需要 64 位 Windows。"
  Abort
 ${EndIf}
 ${IfNot} ${AtLeastWin10}
  MessageBox MB_ICONSTOP "Lake 需要 Windows 10 1809 或更新版本。"
  Abort
 ${EndIf}
 ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
 IntCmp $0 17763 version_ok unsupported version_ok
 unsupported:
  MessageBox MB_ICONSTOP "Lake 终端需要 Windows 10 1809（17763）或更新版本。"
  Abort
 version_ok:
FunctionEnd

Function .onInstSuccess
 ${If} $LakeUpdate == "1"
  Exec '"$INSTDIR\Lake.exe"'
 ${EndIf}
FunctionEnd

Section "${APP_NAME}"
 SetShellVarContext current
 SetOutPath "$INSTDIR"
 File /r "${APP_FILES}"
 ExecWait '"$INSTDIR\Lake.exe" --check-webview' $0
 ${If} $0 != 0
  System::Call 'kernel32::SetEnvironmentVariable(t "LAKE_WEBVIEW_BOOTSTRAPPER", t "$INSTDIR\resources\WebView2Setup.exe")'
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$s=Get-AuthenticodeSignature -LiteralPath $$env:LAKE_WEBVIEW_BOOTSTRAPPER; if ($$s.Status -ne $\"Valid$\" -or $$s.SignerCertificate.Subject -notmatch $\"Microsoft Corporation$\") {exit 1}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
   MessageBox MB_ICONSTOP "WebView2 安装程序签名无效，请重新下载安装包。"
   Abort
  ${EndIf}
  ExecWait '"$INSTDIR\resources\WebView2Setup.exe" /silent /install' $0
  ExecWait '"$INSTDIR\Lake.exe" --check-webview' $0
  ${If} $0 != 0
   MessageBox MB_ICONSTOP "WebView2 尚未就绪，请联网安装 Microsoft Edge WebView2 Runtime 后重试。"
   Abort
  ${EndIf}
 ${EndIf}
 CreateDirectory "$SMPROGRAMS\${APP_NAME}"
 CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\Lake.exe"
 CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\Lake.exe"
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
SectionEnd

Section "Uninstall"
 SetShellVarContext current
 Delete "$DESKTOP\${APP_NAME}.lnk"
 Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
 RMDir "$SMPROGRAMS\${APP_NAME}"
 Delete "$INSTDIR\Lake.exe"
 Delete "$INSTDIR\README.md"
 Delete "$INSTDIR\Uninstall.exe"
 RMDir /r "$INSTDIR\resources"
 RMDir "$INSTDIR"
 DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_KEY}"
 ; Release and Dev user data live outside INSTDIR and are intentionally retained.
SectionEnd
