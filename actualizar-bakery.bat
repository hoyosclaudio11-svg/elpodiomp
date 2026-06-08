@echo off
chcp 65001 >nul
echo 🥐 Actualizando ofertas de panadería...
echo.
cd /d E:\elpodiomp
call git pull
call npm install --silent
node scripts\auto-update-bakery.js
echo.
echo Listo. Las ofertas ya están publicadas en elpodiomp.com.ar
pause
