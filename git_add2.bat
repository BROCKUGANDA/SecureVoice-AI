@echo off
cd /d C:\Users/HP/Desktop\SecureVoiceai
git add src/lib/config.ts src/lib/flags.ts src/lib/llm.ts src/lib/elevenlabs/client.ts src/app/api/console/fire/route.ts src/app/api/tts/route.ts src/lib/tts-quota.ts src/app/api/v1/interventions/route.ts
git status --short
echo "=== end ==="
