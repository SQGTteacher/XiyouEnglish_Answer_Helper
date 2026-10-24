@echo off
chcp 65001 >nul
rem XiyouAnswerHelper launcher
rem If ELECTRON_RUN_AS_NODE is set in this shell, Electron degrades to plain Node.
rem Clear it before starting the GUI.
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
cd /d "%~dp0"
start "" "%~dp0XiyouAnswerHelper.exe"
exit /b 0
