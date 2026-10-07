@echo off
cd /d C:\Users\HP\Desktop\SecureVoiceai
del check_line.mjs run_ts.mjs run_check.bat run_verify.mjs run_verify.bat 2>nul
del check_verify.mjs clean_verify.bat 2>nul
echo Temp files cleaned
bun run verify
echo VERIFY_EXIT=%ERRORLEVEL%
del %0 2>nul
