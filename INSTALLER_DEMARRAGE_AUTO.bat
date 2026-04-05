@echo off
title Installation demarrage automatique - Tinkerbells Bot
color 0A

echo.
echo  ================================================
echo   Installation du demarrage automatique
echo  ================================================
echo.

cd /d "%~dp0"

:: Verifier Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo  ERREUR: Node.js n'est pas installe !
    echo  Telecharge-le sur https://nodejs.org
    pause
    exit /b 1
)

:: Installer dependances
echo  Installation des dependances npm...
call npm install
echo.

:: Demander la cle OpenAI
set /p OPENAI_API_KEY="  Entre ta cle OpenAI: "

:: Installer PM2 globalement
echo.
echo  Installation de PM2...
call npm install -g pm2
call npm install -g pm2-windows-startup

echo.
echo  Configuration du demarrage automatique Windows...
call pm2-startup install

:: Arreter si une instance tourne deja
call pm2 delete tinkerbells 2>nul

:: Demarrer le bot avec la cle OpenAI
echo.
echo  Demarrage du bot avec PM2...
call pm2 start index.js --name tinkerbells --env OPENAI_API_KEY=%OPENAI_API_KEY%

:: Sauvegarder la configuration PM2
call pm2 save

echo.
echo  ================================================
echo   Installation terminee !
echo  ================================================
echo.
echo  Le bot va maintenant demarrer automatiquement
echo  a chaque demarrage de Windows.
echo.
echo  Commandes utiles :
echo    pm2 status          - voir l'etat du bot
echo    pm2 logs tinkerbells - voir les logs
echo    pm2 restart tinkerbells - redemarrer le bot
echo    pm2 stop tinkerbells    - arreter le bot
echo.
echo  Ouvre http://localhost:3000 pour scanner le QR code
echo.
start http://localhost:3000
pause
