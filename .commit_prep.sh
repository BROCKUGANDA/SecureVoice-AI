#!/bin/bash
set -e
cd "C:/Users/HP/Desktop/SecureVoiceai"
echo "=== COMMIT SUMMARY ==="
echo "Stash (verified intact): stash@{0} seat-rbac-wip"
echo "New tracked files:"
git ls-files --others --exclude-standard | grep -v "\.openchamber" | grep -v "scripts/_tmp" | grep -v "scripts/build_demo_reel\.py" | grep -v "demo/00-title\.png" | grep -v "s+r\.kb" | grep -v "\.txt$"
echo "Image/video state: .openchamber/screenshots MISSING; demo/securevoice-demo.mp4 MISSING (script offset bug FIXED; requires source frames to rebuild)"
echo "=== COMMIT ==="
# Add only real work files (not temp artifacts or pre-existing untracked)
git add -A -- ':!scripts/_tmp-probe.mjs' ':!scripts/_tmp-probe' ':!C:\Users\HP\AppData\Local\Temp'
echo "Staging complete. Status:"
git diff --cached --stat -- . ':!C:\Users\HP\AppData\Local\Temp'
