// Hot wallet vault in chrome.storage.local. Two formats:
//  - no lock: secret stored as-is ({ plain: true }), always available
//  - extension lock on: PBKDF2 -> AES-GCM encrypted; while unlocked the key lives in
//    chrome.storage.session (memory-only, cleared on browser restart, not readable by
//    content scripts) and auto-locks after autoLockMin.
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const ITER = 310_000;
const enc = new TextEncoder();
const b64e = (u8) => btoa(String.fromCharCode(...u8));
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function encryptSecret(secret, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secret));
  return { v: 1, iter: ITER, salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) };
}

async function decryptSecret(box, password) {
  const key = await deriveKey(password, b64d(box.salt));
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(box.iv) }, key, b64d(box.ct)));
  } catch (_) {
    throw new Error('wrong password');
  }
}

function parseSecret(input) {
  const s = String(input || '').trim();
  let bytes;
  if (s.startsWith('[')) bytes = Uint8Array.from(JSON.parse(s));
  else bytes = bs58.decode(s);
  if (bytes.length !== 64) throw new Error('secret key must be 64 bytes (base58 or JSON array)');
  // validates that pubkey half matches the seed
  return Keypair.fromSecretKey(bytes);
}

let cached = null; // Keypair while unlocked

// vault formats:
//   { plain: true, sk, pubkey }                 no password: always available
//   { v, iter, salt, iv, ct, pubkey }           password-encrypted: unlock per session
export async function status() {
  const { vault } = await chrome.storage.local.get('vault');
  const kp = await getKeypair();
  return { exists: !!vault, pubkey: vault ? vault.pubkey : null, unlocked: !!kp, encrypted: !!(vault && !vault.plain) };
}

async function store(kp, password) {
  const pubkey = kp.publicKey.toBase58();
  if (password) {
    if (password.length < 4) throw new Error('password too short');
    await chrome.storage.local.set({ vault: { ...(await encryptSecret(kp.secretKey, password)), pubkey } });
    await setUnlocked(kp);
  } else {
    await chrome.storage.local.set({ vault: { plain: true, sk: b64e(kp.secretKey), pubkey } });
    cached = kp;
  }
  return pubkey;
}

export async function create(password, importSecret) {
  const { vault } = await chrome.storage.local.get('vault');
  if (vault) throw new Error('a wallet already exists; remove it first');
  const kp = importSecret ? parseSecret(importSecret) : Keypair.generate();
  return store(kp, password || null);
}

async function secretOf(vault, password) {
  if (vault.plain) return b64d(vault.sk);
  return decryptSecret(vault, password);
}

export async function unlock(password) {
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) throw new Error('no wallet');
  const kp = Keypair.fromSecretKey(await secretOf(vault, password));
  if (kp.publicKey.toBase58() !== vault.pubkey) throw new Error('vault corrupted');
  if (!vault.plain) await setUnlocked(kp);
  return vault.pubkey;
}

// set, change or remove the password (empty newPassword = store without password)
export async function setPassword(oldPassword, newPassword) {
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) throw new Error('no wallet');
  const kp = Keypair.fromSecretKey(await secretOf(vault, oldPassword));
  await lock();
  return store(kp, newPassword || null);
}

export async function reveal(password) {
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) throw new Error('no wallet');
  return bs58.encode(await secretOf(vault, password));
}

export async function remove(password) {
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) return;
  await secretOf(vault, password); // encrypted vaults require the password
  await lock();
  await chrome.storage.local.remove('vault');
}

async function setUnlocked(kp) {
  cached = kp;
  await chrome.storage.session.set({ sk: b64e(kp.secretKey), unlockedAt: Date.now() });
}

export async function lock() {
  cached = null;
  await chrome.storage.session.remove(['sk', 'unlockedAt']);
}

export async function getKeypair() {
  const { vault, autoLockMin = 60 } = await chrome.storage.local.get(['vault', 'autoLockMin']);
  if (!vault) { cached = null; return null; }
  if (vault.plain) {
    if (!cached || cached.publicKey.toBase58() !== vault.pubkey) cached = Keypair.fromSecretKey(b64d(vault.sk));
    return cached;
  }
  const { sk, unlockedAt } = await chrome.storage.session.get(['sk', 'unlockedAt']);
  if (!sk) { cached = null; return null; }
  if (autoLockMin > 0 && Date.now() - unlockedAt > autoLockMin * 60_000) { await lock(); return null; }
  if (!cached) cached = Keypair.fromSecretKey(b64d(sk));
  return cached;
}
