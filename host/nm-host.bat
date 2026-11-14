@echo off
REM Native messaging host launcher for the Tencent AI Detect extension.
REM The browser runs this file directly.
REM stdout carries length-prefixed protocol frames, so nothing here may write to it.
setlocal
node "%~dp0..\src\host\native-host.cjs" %*
