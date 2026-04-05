@echo off
title Tinkerbells Bot WhatsApp
color 0D

echo.
echo  ================================================
echo   Tinkerbells Bot WhatsApp - Demarrage
echo  ================================================
echo.

:: Aller dans le dossier du script
cd /d "%~dp0"

:: Verifier si Node.js est installe
node --version >nul 2>&1
if errorlevel 1 (
    echo  ERREUR: Node.js n'est pas installe !
    echo  Telecharge-le sur https://nodejs.org ^(version LTS^)
    echo.
    pause
    exit /b 1
)

:: Verifier si la cle OpenAI est configuree
if "%OPENAI_API_KEY%"=="" (
    echo  ATTENTION: La variable OPENAI_API_KEY n'est pas definie.
    echo  Entre ta cle OpenAI ci-dessous :
    set /p OPENAI_API_KEY="  Cle OpenAI: "
)

:: Installer les dependances si node_modules absent
if not exist "node_modules" (
    echo  Installation des dependances...
    call npm install
    echo.
)

echo  Demarrage du bot...
echo  Ouvre http://localhost:3000 dans ton navigateur pour scanner le QR code
echo.
echo  Pour arreter le bot : appuie sur Ctrl+C
echo.

node index.js

pause
