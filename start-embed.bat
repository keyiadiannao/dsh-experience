@echo off
title dsh-experience embedding server
rem Local semantic-embedding service for dsh-experience (bge-large-zh).
rem Run once and keep alive; the store falls back to lexical search when down.
cd /d "%~dp0"

set "PY=C:\Users\26433\miniconda3\envs\mamba2\python.exe"
if not exist "%PY%" set "PY=python"

echo Starting embedding server (bge-large-zh, 127.0.0.1:8001) ...
echo   Keep this window open. Press Ctrl+C to stop.
echo.
"%PY%" embed-server.py
if errorlevel 1 pause
