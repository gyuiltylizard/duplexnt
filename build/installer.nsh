; Своё включение в NSIS-скрипт electron-builder (B-26): вопрос о данных пользователя при удалении.
;
; Деинсталлятор не трогает сканы и настройки сам — «данные священны» (CLAUDE.md, ADR 0004).
; Страница после «Добро пожаловать» деинсталлятора объясняет, где лежат данные, и даёт галочку
; «удалить и их», по умолчанию снятую. Тихое удаление (/S — обновление, winget) страницу не
; показывает: данные остаются. Удаление самих данных — здесь же, в секции удаления, через
; customUnInstall; встроенный deleteAppDataOnUninstall остаётся выключенным.
;
; Порядок компиляции: electron-builder вставляет этот файл ДО installer.nsi, то есть до MUI2.nsh,
; поэтому всё, чему нужны макросы MUI и nsDialogs, лежит в макросах customHeader /
; customUnWelcomePage / customUnInstall — они раскрываются позже, в нужных местах. Строки — через
; LangString с числовыми LCID, как у самого electron-builder; языки установщика ограничены
; двумя (installerLanguages в electron-builder.yml): makensis идёт с -WX, и строка без перевода
; для какого-нибудь из сорока языков уронила бы сборку.

LangString duplexntDataTitle 1033 "Scans and settings"
LangString duplexntDataTitle 1049 "Сканы и настройки"
LangString duplexntDataSubtitle 1033 "Your data stays on this computer unless you decide otherwise"
LangString duplexntDataSubtitle 1049 "Данные остаются на компьютере, пока вы не решите иначе"
LangString duplexntDataText 1033 "Duplexn't keeps the pages of your last scan and your settings in this folder:"
LangString duplexntDataText 1049 "Duplexn't хранит страницы последнего сканирования и настройки в этой папке:"
LangString duplexntDataKeep 1033 "They stay after the app is removed. Tick the box to delete them too."
LangString duplexntDataKeep 1049 "После удаления приложения они остаются. Чтобы удалить и их, поставьте галочку."
LangString duplexntDataCheckbox 1033 "Also delete my scans and settings"
LangString duplexntDataCheckbox 1049 "Удалить и мои сканы и настройки"

!macro customHeader
  ; Только в сборке деинсталлятора: в установщике функции un.* и переменные не нужны, а
  ; «not referenced» для NSIS — предупреждение, которое -WX превращает в ошибку.
  !ifdef BUILD_UNINSTALLER
  !include "nsDialogs.nsh"
  !include "LogicLib.nsh"

  ; Состояние галочки: ${BST_CHECKED} — удалить; пусто (тихий режим) или ${BST_UNCHECKED} — оставить.
  Var deleteUserData
  Var deleteUserDataCheckbox

  Function un.duplexntDataPageCreate
    !insertmacro MUI_HEADER_TEXT "$(duplexntDataTitle)" "$(duplexntDataSubtitle)"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 24u "$(duplexntDataText)"
    Pop $0
    ; Данные приложения Electron — всегда в профиле пользователя, даже при установке для всех.
    ${NSD_CreateText} 0 26u 100% 12u "$APPDATA\${APP_FILENAME}"
    Pop $0
    SendMessage $0 ${EM_SETREADONLY} 1 0
    ${NSD_CreateLabel} 0 44u 100% 24u "$(duplexntDataKeep)"
    Pop $0
    ${NSD_CreateCheckbox} 0 74u 100% 12u "$(duplexntDataCheckbox)"
    Pop $deleteUserDataCheckbox
    ${NSD_SetState} $deleteUserDataCheckbox ${BST_UNCHECKED}
    nsDialogs::Show
  FunctionEnd

  Function un.duplexntDataPageLeave
    ${NSD_GetState} $deleteUserDataCheckbox $deleteUserData
  FunctionEnd
  !endif
!macroend

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.duplexntDataPageCreate un.duplexntDataPageLeave
!macroend

!macro customUnInstall
  ${If} $deleteUserData == ${BST_CHECKED}
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    RMDir /r "$APPDATA\${APP_FILENAME}"
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
