/**
 * A VAPID key pair, generated locally, for `pnpm sync-api push keygen`.
 *
 * NOT `web-push`'s OWN GENERATOR, and the reason is the CLI rather than the
 * cryptography. `scripts/sync-api/main.ts` is a thin HTTP client that must run
 * from a laptop with no Postgres and no environment
 * (`tests/unit/sync-api-no-db-imports.test.ts` walks its import graph and
 * fails if that stops being true), and dragging a push library into that graph
 * to produce 97 bytes of key material would be a dependency for nothing. What
 * `web-push` does here is exactly what this does: a P-256 pair, the public key
 * as the uncompressed point, both base64url.
 *
 * THE PAIR IS PRINTED ONCE AND NEVER STORED. The private key belongs in the
 * operator's vault; nothing in this service writes it anywhere.
 *
 * Pure apart from the randomness, and `node:crypto` is its only import.
 */
import { generateKeyPairSync } from 'node:crypto';

/** The two values that go into the environment. Both base64url, both without padding. */
export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

/** The uncompressed point prefix of SEC1 §2.3.3. A VAPID public key is 65 bytes and starts with it. */
const UNCOMPRESSED_POINT = 0x04;

/** One coordinate of a P-256 point, in bytes. Both halves of the public key are this long. */
const P256_COORDINATE_BYTES = 32;

/** A JWK coordinate as raw bytes, left padded to the curve's width so the point is always 65 bytes. */
function coordinateBytes(value: string | undefined): Buffer {
  const raw = Buffer.from(value ?? '', 'base64url');
  if (raw.length >= P256_COORDINATE_BYTES) return raw.subarray(raw.length - P256_COORDINATE_BYTES);
  return Buffer.concat([Buffer.alloc(P256_COORDINATE_BYTES - raw.length), raw]);
}

/**
 * A fresh application server key pair.
 *
 * The public key is the uncompressed point `04 || x || y`, which is the form
 * every push service and every browser's `applicationServerKey` expects; the
 * private key is the raw scalar.
 */
export function generateVapidKeys(): VapidKeyPair {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const privateJwk = pair.privateKey.export({ format: 'jwk' });

  const point = Buffer.concat([
    Buffer.from([UNCOMPRESSED_POINT]),
    coordinateBytes(publicJwk.x),
    coordinateBytes(publicJwk.y),
  ]);

  return {
    publicKey: point.toString('base64url'),
    privateKey: coordinateBytes(privateJwk.d).toString('base64url'),
  };
}
