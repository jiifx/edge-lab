; Tauri's NSIS template writes UninstallString but not QuietUninstallString.
; winget-cli's uninstall flow prefers SilentUninstallCommand - which it sources from
; QuietUninstallString - on EVERY uninstall, and it never synthesises "/S" for NSIS
; packages. Without this key, `winget uninstall "Prop Edge Lab 2"` pops the interactive
; uninstaller window instead of removing the app unattended.
;
; POSTINSTALL runs after the template's own WriteRegStr calls, so this adds to the same
; key (${UNINSTKEY}) in the same registry context (SHCTX, per-user by default here).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "${UNINSTKEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
!macroend
