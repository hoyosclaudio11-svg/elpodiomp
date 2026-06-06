@echo off
cd /d E:\elpodiomp
echo ===========================================
echo   El Podio MP - Pipeline Auto-Update
echo   %date% %time%
echo ===========================================
echo.
node scripts\auto-update.js
echo.
echo Pipeline terminado. Presiona cualquier tecla para cerrar...
pause >nul
