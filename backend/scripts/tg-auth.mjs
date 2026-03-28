#!/usr/bin/env node
/**
 * Interactive Telegram Client auth via GramJS.
 * Saves the session string so the backend can pick it up.
 *
 * Usage: node scripts/tg-auth.mjs
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const apiId = parseInt(await ask('API ID: '), 10);
const apiHash = await ask('API Hash: ');
const phone = await ask('Phone (+...): ');

const session = new StringSession('');
const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: () => Promise.resolve(phone),
  phoneCode: async () => {
    return await ask('Enter the code you received: ');
  },
  password: async () => {
    return await ask('Enter 2FA password (if prompted): ');
  },
  onError: (err) => console.error('Auth error:', err.message),
});

const sessionString = client.session.save();
console.log('\n✅ Authenticated successfully!');
console.log('\nSession string (save this):\n');
console.log(sessionString);

// Save to settings via API
try {
  const saveRes = await fetch('http://localhost:2901/api/settings/telegram_client.session', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: sessionString }),
  });
  if (saveRes.ok) {
    console.log('\n✅ Session saved to Argus settings automatically.');
  }

  // Also save api_id, api_hash, phone
  await fetch('http://localhost:2901/api/settings/telegram_client.api_id', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: String(apiId) }),
  });
  await fetch('http://localhost:2901/api/settings/telegram_client.api_hash', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: apiHash }),
  });
  await fetch('http://localhost:2901/api/settings/telegram_client.phone', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: phone }),
  });
  console.log('✅ Credentials saved to Argus settings.');
} catch {
  console.log('\n⚠️  Could not auto-save. Copy the session string above and save it manually.');
}

await client.disconnect();
rl.close();
process.exit(0);
