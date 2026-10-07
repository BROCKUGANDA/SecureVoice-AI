@echo off
cd /d C:\Users\HP\Desktop\SecureVoiceai
git add src/lib/config.ts src/lib/llm.ts src/lib/elevenlabs/egress.ts src/lib/elevenlabs/client.ts src/lib/flags.ts src/lib/outbox.ts src/lib/queue/qstash.ts src/lib/payments/paystack.ts src/app/api/v1/interventions/route.ts src/app/api/console/fire/route.ts src/app/api/elevenlabs/signed-url/route.ts src/app/api/tts/route.ts src/lib/tts-quota.ts .env.example
git status --short
echo "=== end ==="
del %0
