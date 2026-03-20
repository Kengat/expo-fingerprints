@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  Запуск dev-сервера Vite — http://localhost:3000
echo  Остановка: Ctrl+C в этом окне
echo.
call npm run dev
if errorlevel 1 pause
