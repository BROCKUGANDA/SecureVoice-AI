@echo off
cd /d C:\Users/HP\Desktop\SecureVoiceai
git add -A
git commit -m "chore: finalize hardcoded value elimination and env-driven config"
echo "=== commit done ==="
git log --oneline -3
echo "=== end ==="
del git_add.bat git_add2.bat verify_run.bat 2>nul
