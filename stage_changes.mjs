import { execSync } from 'node:child_process';

function run(cmd) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', cwd: process.cwd() });
    if (out) console.log(out);
    return out;
  } catch (e) {
    console.log('CMD FAILED:', e.status);
    console.log(e.stdout || e.message);
    return null;
  }
}

// Stage all modified source files
run('git add src/lib/config.ts src/lib/llm.ts src/lib/elevenlabs/egress.ts src/lib/elevenlabs/client.ts src/lib/flags.ts src/lib/outbox.ts src/lib/queue/qstash.ts src/lib/payments/paystack.ts src/app/api/v1/interventions/route.ts src/app/api/console/fire/route.ts src/app/api/elevenlabs/signed-url/route.ts src/app/api/tts/route.ts src/lib/tts-quota.ts .env.example');

// Check status
const status = run('git status --short');
console.log('\\n=== Status ===');
console.log(status);
