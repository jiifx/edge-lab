; Tauri's NSIS template writes UninstallString but not QuietUninstallString.
; winget-cli's uninstall flow prefers SilentUninstallCommand - which it sources from
; QuietUninstallString - on EVERY uninstall, and it never synthesises "/S" for NSIS
; packages. Without this key, `winget uninstall "Edge Lab"` pops the interactive
; uninstaller window instead of removing the app unattended.
;
; POSTINSTALL runs after the template's own WriteRegStr calls, so this adds to the same
; key (${UNINSTKEY}) in the same registry context (SHCTX, per-user by default here).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "${UNINSTKEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
  ; the program file was prop-edge-lab.exe until 2.18.6 (now edge-lab.exe); an
  ; update over an older install would otherwise leave the old one behind
  Delete "$INSTDIR\prop-edge-lab.exe"
!macroend
