@echo off
chcp 65001 >nul
title BigBanana AI Director - 启动中
cd /d "%~dp0"
echo ============================================================
echo   BigBanana AI Director (AI 漫剧导演工场) · 本地一键启动
echo   本地服务地址: http://localhost:5173
echo   自动载入 60s 喜剧 Demo (《这单只剩一块》25镜分镜与资产)
echo ============================================================

start "" "http://localhost:5173/auto-import.html"
npm run dev
pause
