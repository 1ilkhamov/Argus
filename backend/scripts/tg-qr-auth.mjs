#!/usr/bin/env node
/**
 * QR Code Telegram auth via GramJS.
 * Generates a QR code in the terminal — scan it with Telegram on your phone.
 * Saves session string to Argus settings automatically.
 *
 * Usage: node scripts/tg-qr-auth.mjs
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { computeCheck } from 'telegram/Password.js';
import readline from 'readline';
import { Buffer } from 'buffer';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const apiId = parseInt(await ask('API ID: '), 10);
const apiHash = await ask('API Hash: ');

const session = new StringSession('');
const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5,
});

await client.connect();
console.log('\nConnected to Telegram. Generating QR code...\n');

let qrTerminal;
try {
  qrTerminal = require('qrcode-terminal');
} catch {
  console.log('Installing qrcode-terminal...');
  const { execSync } = await import('child_process');
  execSync('npm install --no-save qrcode-terminal', { stdio: 'inherit' });
  qrTerminal = require('qrcode-terminal');
}

let authorized = false;

while (!authorized) {
  const result = await client.invoke(
    new Api.auth.ExportLoginToken({
      apiId,
      apiHash,
      exceptIds: [],
    }),
  );

  if (result.className === 'auth.LoginToken') {
    const tokenBase64 = Buffer.from(result.token).toString('base64url');
    const qrUrl = `tg://login?token=${tokenBase64}`;

    console.log('📱 Scan this QR code with Telegram on your phone:');
    console.log('   Telegram → Settings → Devices → Link Desktop Device\n');
    qrTerminal.generate(qrUrl, { small: true }, (qr) => {
      console.log(qr);
    });
    console.log(`\nToken expires in ${result.expires - Math.floor(Date.now() / 1000)}s`);
    console.log('Waiting for scan...\n');

    // Wait for the token to be accepted (poll every 2s)
    const expiry = result.expires * 1000;
    while (Date.now() < expiry && !authorized) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const check = await client.invoke(
          new Api.auth.ExportLoginToken({
            apiId,
            apiHash,
            exceptIds: [],
          }),
        );
        if (check.className === 'auth.LoginTokenSuccess') {
          authorized = true;
          console.log('\n✅ QR code scanned! Authenticated successfully!');
        } else if (check.className === 'auth.LoginTokenMigrateTo') {
          // Need to reconnect to another DC
          console.log(`Migrating to DC ${check.dcId}...`);
          await client._switchDC(check.dcId);
          const imported = await client.invoke(
            new Api.auth.ImportLoginToken({ token: check.token }),
          );
          if (imported.className === 'auth.LoginTokenSuccess') {
            authorized = true;
            console.log('\n✅ QR code scanned! Authenticated successfully!');
          }
        }
      } catch (err) {
        if (err.message?.includes('SESSION_PASSWORD_NEEDED')) {
          const password = await ask('Enter 2FA password: ');
          const passwordSrp = await client.invoke(new Api.account.GetPassword());
          const srpResult = await computeCheck(passwordSrp, password);
          await client.invoke(new Api.auth.CheckPassword({ password: srpResult }));
          authorized = true;
          console.log('\n✅ 2FA passed! Authenticated successfully!');
        }
        // TOKEN_EXPIRED or other errors — will regenerate
        break;
      }
    }

    if (!authorized) {
      console.log('QR expired, generating new one...\n');
    }
  } else if (result.className === 'auth.LoginTokenSuccess') {
    authorized = true;
    console.log('\n✅ Already authenticated!');
  } else if (result.className === 'auth.LoginTokenMigrateTo') {
    console.log(`Migrating to DC ${result.dcId}...`);
    await client._switchDC(result.dcId);
  }
}

// Get session string
const sessionString = client.session.save();
console.log('\nSession string:\n');
console.log(sessionString);

// Save to Argus settings
try {
  const base = 'http://localhost:2901/api/settings';
  const put = (key, value) =>
    fetch(`${base}/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });

  await put('telegram_client.session', sessionString);
  await put('telegram_client.api_id', String(apiId));
  await put('telegram_client.api_hash', apiHash);
  console.log('\n✅ Session and credentials saved to Argus settings.');
  console.log('Now restart the backend or call POST /api/telegram-client/restart');
} catch {
  console.log('\n⚠️  Could not auto-save. Copy session string above and save manually.');
}

await client.disconnect();
rl.close();
process.exit(0);
