@echo off
rem Nightly Slate Lab report: pull last night's contests, refresh the sharps roster, grade the engine.
rem Scheduled by Windows Task Scheduler ("Slate Lab nightly report"); output goes to data\reports\log.txt.
cd /d "%~dp0.."
echo ---- %date% %time% ---- >> data\reports\log.txt
"C:\Program Files\nodejs\node.exe" bench\report.mjs MLB >> data\reports\log.txt 2>&1
"C:\Program Files\nodejs\node.exe" bench\report.mjs NFL >> data\reports\log.txt 2>&1
