@echo off
REM Registers the native messaging host for Microsoft Edge (per-user).
REM Run once after the extension is loaded unpacked.

set "HOST_MANIFEST=%~dp0nm-manifest.json"
REM Update the executable path for the current installation folder.
node "%~dp0update-manifest.cjs"
if errorlevel 1 (
  echo FAILED to update native host manifest path
  exit /b 1
)
set "REG_KEY=HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.afei.tencent_ai_detect_relay"

reg add "%REG_KEY%" /ve /t REG_SZ /d "%HOST_MANIFEST%" /f
if errorlevel 1 (
  echo FAILED to write %REG_KEY%
  exit /b 1
)

echo Registered:
reg query "%REG_KEY%" /ve
