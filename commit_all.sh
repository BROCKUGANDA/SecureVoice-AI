#!/bin/bash
set -e
cd "C:/Users/HP/Desktop/SecureVoiceai"
# Stage all real work (new module + edits), excluding temp artifacts only
# .openchamber and demo sources are NOT added (screenshots missing; video not rebuilt)
git add -A
echo "Staged:"
git diff --cached --name-only | head -30
