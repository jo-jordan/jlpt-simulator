const encoder = new TextEncoder()
const PBKDF2_ITERATIONS = 100_000

function toBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  const binary = atob(`${normalized}${padding}`)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function importHmacKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function signToken(secret: string, payload: Record<string, unknown>) {
  const encodedPayload = toBase64Url(encoder.encode(JSON.stringify(payload)))
  const key = await importHmacKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(encodedPayload))
  return `${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`
}

export async function verifyToken<T>(secret: string, token: string): Promise<T | null> {
  const [payloadPart, signaturePart] = token.split('.')

  if (!payloadPart || !signaturePart) {
    return null
  }

  const key = await importHmacKey(secret)
  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    fromBase64Url(signaturePart),
    encoder.encode(payloadPart),
  )

  if (!isValid) {
    return null
  }

  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadPart))) as T & {
    exp?: number
  }

  if (payload.exp && payload.exp < Date.now()) {
    return null
  }

  return payload
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  )

  return `${toBase64Url(salt)}.${toBase64Url(new Uint8Array(bits))}`
}

export async function verifyPassword(password: string, passwordHash: string) {
  const [saltPart, hashPart] = passwordHash.split('.')

  if (!saltPart || !hashPart) {
    return false
  }

  const salt = fromBase64Url(saltPart)
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  )

  return toBase64Url(new Uint8Array(bits)) === hashPart
}

async function importAesKey(secret: string) {
  const secretDigest = await crypto.subtle.digest('SHA-256', encoder.encode(secret))
  return crypto.subtle.importKey('raw', secretDigest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptText(secret: string, value: string) {
  const key = await importAesKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(value))
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`
}

export async function decryptText(secret: string, value: string) {
  const [ivPart, cipherPart] = value.split('.')

  if (!ivPart || !cipherPart) {
    throw new Error('Invalid encrypted payload.')
  }

  const key = await importAesKey(secret)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(ivPart) },
    key,
    fromBase64Url(cipherPart),
  )

  return new TextDecoder().decode(decrypted)
}
