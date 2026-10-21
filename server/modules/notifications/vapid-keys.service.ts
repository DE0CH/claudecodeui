// @ts-nocheck -- web-push does not provide declarations in this project.
import webPush from 'web-push';

import { vapidKeysDb } from '../database/index.js';

let cachedKeys = null;

/** Loads (or creates and stores) the VAPID key pair; cached after the first call. */
async function ensureVapidKeys() {
  if (cachedKeys) return cachedKeys;

  const stored = await vapidKeysDb.getVapidKeys();
  if (stored) {
    cachedKeys = stored;
    return cachedKeys;
  }

  const keys = webPush.generateVAPIDKeys();
  await vapidKeysDb.createVapidKeys(keys.publicKey, keys.privateKey);
  cachedKeys = keys;
  return cachedKeys;
}

/** The public key; configureWebPush() (server start) loads it first. */
function getPublicKey() {
  return cachedKeys ? cachedKeys.publicKey : null;
}

async function configureWebPush() {
  const keys = await ensureVapidKeys();
  webPush.setVapidDetails(
    'mailto:noreply@claudecodeui.local',
    keys.publicKey,
    keys.privateKey
  );
  console.log('Web Push notifications configured');
}

export { ensureVapidKeys, getPublicKey, configureWebPush };
