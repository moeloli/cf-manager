@echo off
chcp 65001 > nul 2>&1
setlocal EnableDelayedExpansion

set "REPO=hefy2027/cf-manager"
set "RAW_URL=https://raw.githubusercontent.com/%REPO%/master/reg"
set "INSTALL_DIR=%CD%"
set "MIN_NODE_VERSION=20"

echo ==================================================
echo  Cloudflare Batch Registration Tool - Installer
echo ==================================================
echo.

REM ── 检测 Node.js ──────────────────────────────────────
echo [1/4] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js not found. Please install Node.js ^>= %MIN_NODE_VERSION%
    echo    Visit: https://nodejs.org
    pause
    exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -v') do set "NODE_VER=%%v"
set "NODE_VER=%NODE_VER:v=%"
if %NODE_VER% LSS %MIN_NODE_VERSION% (
    echo ❌ Node.js v%NODE_VER% is too old. Requires ^>= v%MIN_NODE_VERSION%
    echo    Visit: https://nodejs.org
    pause
    exit /b 1
)

echo ✅ Node.js %NODE_VER% detected

REM ── 检测 npm ───────────────────────────────────────────
echo [2/4] Checking npm...
where npm >nul 2>&1
if errorlevel 1 (
    echo ❌ npm not found. Please reinstall Node.js
    pause
    exit /b 1
)
echo ✅ npm detected

REM ── 下载 / 确认文件 ────────────────────────────────────
echo [3/4] Preparing files...

if not exist "%INSTALL_DIR%\cf-reg.mjs" (
    echo    Downloading cf-reg.mjs...
    powershell -Command "Invoke-WebRequest -Uri '%RAW_URL%/cf-reg.mjs' -OutFile '%INSTALL_DIR%\cf-reg.mjs'"
) else (
    echo    cf-reg.mjs already exists, skip download
)

if not exist "%INSTALL_DIR%\config.json" (
    echo    Downloading config.json...
    powershell -Command "Invoke-WebRequest -Uri '%RAW_URL%/config.example.json' -OutFile '%INSTALL_DIR%\config.json'"
) else (
    echo    config.json already exists, skip download
)

REM ── 创建 cf-reg.cmd 包装器 ─────────────────────────────
echo Creating cf-reg.cmd wrapper...
(
echo @echo off
echo node "%INSTALL_DIR%\cf-reg.mjs" %%*
) > "%INSTALL_DIR%\cf-reg.cmd"

echo ✅ Files ready in %INSTALL_DIR%

REM ── 安装依赖 ───────────────────────────────────────────
echo [4/4] Installing dependencies...
cd /d "%INSTALL_DIR%"
echo {"name":"cf-reg-local","version":"1.0.0","type":"module"} > package.json
call npm install --no-save cloakbrowser commander node-fetch playwright-core 2>nul
if errorlevel 1 (
    echo ⚠️  Failed to install some dependencies. Run manually:
    echo    cd %INSTALL_DIR% ^&^& npm install cloakbrowser commander node-fetch playwright-core
) else (
    echo ✅ Dependencies installed
)

echo.
echo ==================================================
echo  Installation complete!
echo ==================================================
echo.
echo Usage:
echo   cf-reg --help
echo   cf-reg --count 5
echo.
echo Or add to PATH for global access:
echo   setx PATH "%%PATH%%;%INSTALL_DIR%"
echo.
echo Config:
echo   Edit %INSTALL_DIR%\config.json to customize settings
echo.
echo CF Manager: https://github.com/%REPO%
echo.
pause
