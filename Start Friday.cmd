@echo off
rem Starts Friday: the notch, which starts the app and the services if they are not running.
rem Double-click this from File Explorer (not from inside another app), so Friday can use the microphone.
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0friday\desktop"
echo %date% %time% Start Friday.cmd ran (by %USERNAME%) >> "%~dp0data\start-friday.log"
start "" "node_modules\electron\dist\electron.exe" .
echo Friday is starting. The notch appears above the taskbar in about 30 seconds.
timeout /t 4 >nul