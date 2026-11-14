@echo off
REM Registers the native messaging host for Microsoft Edge (per-user).
REM Run once after the extension is loaded unpacked, and again after moving this folder.
REM
REM The generated manifest lives OUTSIDE this checkout, in the per-user key folder, because the
REM browser needs an absolute launcher path in it. Keeping it inside the tree made it belong to
REM whichever branch was checked out: switching branches or cleaning removed the file while the
REM registry kept pointing at it, the host then failed to start, and the extension silently did
REM nothing. Outside the tree, no branch or checkout can touch it.

set "STATE_DIR=%USERPROFILE%\.tencent-ai-detect-keys"
set "HOST_MANIFEST=%STATE_DIR%\nm-manifest.json"

REM Generate the manifest for this installation folder from the template.
node "%~dp0register-manifest.cjs"
if errorlevel 1 (
  echo FAILED to generate native host manifest
  exit /b 1
)

if not exist "%HOST_MANIFEST%" (
  echo FAILED: manifest was not written to "%HOST_MANIFEST%"
  exit /b 1
)

set "REG_KEY=HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.afei.tencent_ai_detect_relay"

reg add "%REG_KEY%" /ve /t REG_SZ /d "%HOST_MANIFEST%" /f
if errorlevel 1 (
  echo FAILED to write %REG_KEY%
  exit /b 1
)

echo.
echo Registered:
reg query "%REG_KEY%" /ve
