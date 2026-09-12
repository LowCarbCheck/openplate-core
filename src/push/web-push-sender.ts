/**
 * The ONE module that knows `web-push` exists.
 *
 * EVERYTHING ELSE TAKES A `PushSender`. The tick, the routes and every test
 * are written against `push/send.ts`'s injected function type, so the library's
 * own types never reach a handler or a fake, and swapping the transport is one
 * file. The pattern is collie's (`bridge/push.ts` takes an optional sender) and
 * `refactor-dependencies`' port and adapter in one.
 *
 * THE VAPID DETAILS ARE SET PER SENDER, not globally at import time. The
 * library also offers a process wide `setVapidDetails`, which would make a
 * second instance in one process silently rebind the first one's keys, and the
 * integration harness boots more than one app per run.
 */
import webpush from 'web-push';
import type { PushEndpointCredential, PushSendOptions, PushSender } from './send.js';

/** What the operator configured. The same three values `config.ts` parses. */
export interface VapidCredentials {
  publicKey: string;
  privateKey: string;
  /** A `mailto:` or `https:` URL the push service can use to reach the operator. RFC 8292 requires one. */
  subject: string;
}

/**
 * A sender bound to one instance's VAPID keys.
 *
 * It throws whatever `web-push` throws, unchanged, because the status on that
 * error is what `push/send.ts` reads to decide between a prune and a retry.
 */
export function createWebPushSender(credentials: VapidCredentials): PushSender {
  return async function sendWebPush(
    credential: PushEndpointCredential,
    payload: string,
    options: PushSendOptions,
  ): Promise<void> {
    await webpush.sendNotification(credential, payload, {
      TTL: options.TTL,
      topic: options.topic,
      urgency: options.urgency,
      vapidDetails: {
        subject: credentials.subject,
        publicKey: credentials.publicKey,
        privateKey: credentials.privateKey,
      },
    });
  };
}
