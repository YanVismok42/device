// В Workers нет модуля node:crypto со scrypt — вместо него WebCrypto.
// Отсюда два отличия от прошлой версии: PBKDF2 вместо scrypt и async-функции.

const ITERATIONS = 100_000;
const KEY_BITS = 512;

/** Случайные байты в hex — для соли, токенов доступа и сессий. */
export function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function derive(password, salt) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode(salt),
      iterations: ITERATIONS,
      hash: 'SHA-256'
    },
    key,
    KEY_BITS
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password, salt = randomHex(16)) {
  return `${salt}:${await derive(password, salt)}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  return timingSafeEqual(await derive(password, salt), expected);
}

/**
 * Сравнение за постоянное время: timingSafeEqual из node:crypto здесь нет.
 * Обычное === выходит из цикла на первом различии, и по времени ответа можно
 * подбирать хеш посимвольно.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
