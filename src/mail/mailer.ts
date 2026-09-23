/**
 * The mail PORT — what this service needs from a mailer, and nothing about how
 * one is built.
 *
 * FIVE LETTERS NOW, EACH ONE NAMED HERE AND NOWHERE ELSE. The bound that used
 * to read "three letters, ever" held while every letter this service sent was
 * part of the account lifecycle: an invitation, a password reset, and the note
 * that says an invited address already has an account. M214/09 added two more
 * for a different reason — a statutory acknowledgement of a cancellation or a
 * withdrawal that a person files WITHOUT an account at all — and the bound is
 * now "every letter is named on this interface", not a literal count. A
 * service that can send arbitrary mail grows a notification system, and a
 * notification system needs an address for people who did not ask for one;
 * naming every message this port can send is what keeps that from happening
 * by accretion.
 *
 * THE THIRD ONE IS THE PRICE OF AN INDISTINGUISHABLE `202` (M212).
 * `POST /v1/auth/invites` answers the same thing whatever is true about the
 * address, so a member never learns that a colleague is already here. Without
 * a letter on that branch the invitation would simply vanish and both people
 * would wait for it. It carries NO LINK, which is what keeps it from being a
 * second account or an unrequested password reset, see
 * `account-notice-message.ts`.
 *
 * THE FOURTH AND FIFTH ARE `sendDeclarationReceipt` AND
 * `sendDeclarationOperatorAlert` (M214/09, `mail/declaration-message.ts`). Both
 * go out from `server/legal-declarations.ts` on every declaration, matched or
 * not: the receipt to the person who filed it (and again to a matched
 * account's own address, when it differs), the alert to the operator. Neither
 * carries a token, because there is no account to put one behind. Their words
 * come from the instance's content folder (M246/04), found at send time
 * through the `templates` option; with none, a neutral fallback goes out.
 *
 * WHY AN INTERFACE AND NOT AN HTTP CLIENT. Everything upstream of the
 * transport has to be testable without one: the admin invite route has real
 * branching (mail configured or not, send succeeded or not, and what the
 * response says in each case), and none of it should require a mail server to
 * exercise. This is the seam; the messages themselves are built by
 * `invite-message.ts`, `reset-message.ts` and `declaration-message.ts`, which
 * are pure. An instance with no mail configured gets {@link createNoopMailer}.
 *
 * NOTHING HERE THROWS ON A FAILED SEND, and that is a contract rather than an
 * omission. `POST /v1/auth/reset/request` answers `202` whether or not the
 * account exists; if a send failure could turn that into a `500`, the status
 * code would become the enumeration oracle the endpoint exists to avoid. An
 * implementation logs its own failures and resolves.
 */
import { buildSignupAccountNoticeMessage, buildSignupRequestMessage } from './signup-message.js';
import type { InstanceLanguage, IsoTimestamp } from '../protocol.js';
import type { Logger } from '../logger.js';
import { buildAccountNoticeMessage } from './account-notice-message.js';
import { buildInviteMessage } from './invite-message.js';
import { buildResetMessage } from './reset-message.js';
import {
  alertTemplateName,
  buildDeclarationOperatorAlertMessage,
  buildDeclarationReceiptMessage,
  receiptTemplateName,
  type DeclarationOperatorAlertInput,
  type DeclarationReceiptInput,
} from './declaration-message.js';
import type { DeclarationTemplateSource } from './declaration-templates.js';

export interface SendInviteInput {
  /** The address the invitation goes to — the invite's own `email`, never one from a request body. */
  email: string;
  /** What the operator typed as the person's name, or `null`. */
  displayName: string | null;
  /** The raw `si_` token. Held for as long as one letter takes to build, and never logged. */
  inviteToken: string;
  expiresAt: IsoTimestamp;
}

/**
 * The note for an address that already holds an account. It carries the
 * address and nothing else: no token, no link, and above all not the member
 * who typed it, who must not be named to the reader and must not learn that
 * this letter went at all.
 */
export interface SendAccountNoticeInput {
  /** The account's own address, read off the account row rather than from a request body. */
  email: string;
}

export interface SendResetInput {
  /** The account's own address. */
  email: string;
  /** The raw `sr_` token. Held for as long as one letter takes to build, and never logged. */
  resetToken: string;
  expiresAt: IsoTimestamp;
}

/**
 * The receipt for one declaration (M214/09). Sent once to the address the
 * person typed, and sent AGAIN, separately, to a matched account's own
 * address when it differs — this input carries one recipient, so two sends
 * are two calls, the same pattern `sendInvite` and `sendReset` already use.
 */
export interface SendDeclarationReceiptInput extends DeclarationReceiptInput {
  /** Where THIS send goes. Either the typed address or the matched account's, chosen by the caller. */
  to: string;
}

/** The operator's copy, sent once per declaration regardless of how many receipts went out. English only, see `declaration-message.ts`. */
export type SendDeclarationOperatorAlertInput = DeclarationOperatorAlertInput;

export interface Mailer {
  sendInvite(input: SendInviteInput): Promise<void>;
  sendReset(input: SendResetInput): Promise<void>;
  /** The M212 note. See `SendAccountNoticeInput` above and the module header. */
  sendAccountNotice(input: SendAccountNoticeInput): Promise<void>;
  /**
   * The open sign-up door's letter (M253): the invite's link, in words for a
   * person who asked for it themselves. Never the invitation, which says
   * somebody invited them. See `signup-message.ts`.
   */
  sendSignupRequest(input: SendInviteInput): Promise<void>;
  /** The open sign-up door's note to an address that already holds an account (M253). No link. */
  sendSignupAccountNotice(input: SendAccountNoticeInput): Promise<void>;
  /** M214/09. See `SendDeclarationReceiptInput` above and the module header. */
  sendDeclarationReceipt(input: SendDeclarationReceiptInput): Promise<void>;
  /** M214/09. See `SendDeclarationOperatorAlertInput` above and the module header. */
  sendDeclarationOperatorAlert(input: SendDeclarationOperatorAlertInput): Promise<void>;
}

/**
 * The mailer an instance with no mail configuration gets: it accepts both
 * letters and sends neither.
 *
 * SILENCE HERE IS NOT A DROPPED MESSAGE. An instance without mail hands the
 * operator the link instead — `POST /v1/admin/invites` returns it, and the
 * `sync-api` CLI prints it — so the capability always reaches somebody. What
 * this implementation removes is the alternative: a hard failure that would
 * make a self-hosted instance unusable until its owner stood up a relay, which
 * is the instruction ADR-0004 refused to give and ADR-0005 still refuses.
 */
export function createNoopMailer(): Mailer {
  return {
    async sendInvite(): Promise<void> {
      // Deliberately nothing. See the doc above.
    },
    async sendReset(): Promise<void> {
      // Deliberately nothing. See the doc above.
    },
    async sendSignupRequest(): Promise<void> {
      // Deliberately nothing: `OPEN_SIGNUP` refuses to boot without mail, so
      // this is only ever the default of a test or a misbuilt context.
    },
    async sendSignupAccountNotice(): Promise<void> {
      // Deliberately nothing, as above.
    },
    async sendAccountNotice(): Promise<void> {
      // Deliberately nothing. See the doc above. An instance with no mail
      // hands nobody this note either, and there is no link to fall back on:
      // the member's `202` is unchanged, which is exactly the property the
      // route promises.
    },
    async sendDeclarationReceipt(): Promise<void> {
      // Deliberately nothing. `server/legal-declarations.ts` still answers
      // `202` and the row is still persisted: the statutory record is the
      // row, not the letter, and this instance has told nobody it can mail.
    },
    async sendDeclarationOperatorAlert(): Promise<void> {
      // Deliberately nothing, for the same reason. An operator running with
      // no mail configured reads the row instead.
    },
  };
}

/**
 * 15 s, and NO RETRIES. Every call site already treats a failed send as
 * survivable: the row is written before the send, and the response says
 * `emailed: false` with a link that still works. A retry loop here would be
 * duplicate-email machinery bolted onto a path that is allowed to fail. It is
 * an option rather than a constant because the only caller that needs a
 * different value is a test proving the bound exists; an operator has nothing
 * to tune here.
 */
export const DEFAULT_MAIL_API_TIMEOUT_MS = 15_000;

/** What an operator configured, already validated all-or-nothing by `config.ts`. */
export interface HttpMailConfig {
  url: string;
  apiKey: string;
  from: string;
  /**
   * Where `sendDeclarationOperatorAlert` sends, `MAIL_OPERATOR_EMAIL` (M214/09).
   * Part of the same all-or-nothing mail block as `url`/`apiKey`/`from`: an
   * instance that can mail at all can name who reads its compliance mail, and
   * a mailer with three of the four set would silently drop every declaration
   * alert rather than fail at boot where the operator would see why.
   */
  operatorEmail: string;
}

export interface CreateHttpMailerOptions {
  mail: HttpMailConfig;
  /** The two base URLs a link is built from. Required whenever mail is configured (`config.ts`). */
  links: { clientBaseUrl: string; serverPublicUrl: string };
  /** Which language both letters are written in (`INSTANCE_LANGUAGE`). */
  language: InstanceLanguage;
  /** Where the two declaration letters find their text (M246/04). See `declaration-templates.ts`. */
  templates: DeclarationTemplateSource;
  logger: Logger;
  timeoutMs?: number;
}

/** One message, ready to post. Internal: nothing outside this module builds one. */
interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Posts a Resend-compatible payload to the configured mail API.
 *
 * ONE ADAPTER, NOT ONE PER PROVIDER. Resend and our own pigeon service differ
 * in exactly two ways: the path (`/emails` against `/v1/emails`) and whether
 * `to` may be a bare string. The path is the operator's whole URL, so it never
 * reaches this code; `to` is ALWAYS sent as a one-element array, which Resend
 * accepts and pigeon requires. That is the entire compatibility story, and it
 * is why there is no provider enum and no branch below.
 *
 * GLOBAL `fetch`, NOT UNDICI. Node's `fetch` IS undici, so importing the
 * package would buy nothing and cost an entry on `scripts/build.ts`'s
 * `external` list. This adapter adds no dependency at all, which for a public
 * repo whose every dependency is a supply-chain surface a self-hoster inherits
 * is the point.
 */
async function postMail(input: { mail: HttpMailConfig; timeoutMs: number; outgoing: OutgoingMail }): Promise<void> {
  const response = await fetch(input.mail.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.mail.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: input.mail.from,
      // An array even for one recipient: see the header.
      to: [input.outgoing.to],
      subject: input.outgoing.subject,
      text: input.outgoing.text,
      html: input.outgoing.html,
    }),
    // No retry, and no idempotency key: with nothing retrying, there is no
    // duplicate for a key to suppress. See `DEFAULT_MAIL_API_TIMEOUT_MS`.
    signal: AbortSignal.timeout(input.timeoutMs),
  });

  // THE BODY IS DISCARDED WITHOUT BEING READ, and that is a privacy decision
  // rather than a tidiness one. Both Resend and pigeon echo the request back
  // inside an error body — the recipient address and the subject, and any
  // provider might one day echo the html, which carries the token. Cancelling
  // rather than reading means there is no string in scope for a later
  // `${...}` to put into a message or a log.
  await response.body?.cancel();

  if (!response.ok) {
    // THE STATUS CODE, AND NOTHING ELSE. Not `statusText`, which some
    // providers set from their own error text; not the body; not the URL,
    // which is where a hosted API's credential sometimes ends up as a query
    // parameter.
    throw new Error(`mail API responded ${response.status}`);
  }
}

/**
 * The real mailer: builds each letter with the pure builders and posts it.
 *
 * A FAILED SEND THROWS OUT OF HERE, deliberately, and the CALL SITE decides
 * what that means. The admin invite route answers `201 emailed: false` with a
 * link that still works; `POST /v1/auth/reset/request` answers `202` either
 * way, because letting a send failure change its status code would make that
 * status the enumeration oracle the endpoint exists to avoid. Both log the
 * failure against a row id.
 *
 * NOTHING HERE LOGS A RECIPIENT, A SUBJECT, A BODY OR A LINK. The link carries
 * a token, so it is a credential; the recipient address is personal data held
 * for one send. This module logs that a send was attempted and its outcome,
 * with no argument that could carry either.
 */
export function createHttpMailer(options: CreateHttpMailerOptions): Mailer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MAIL_API_TIMEOUT_MS;
  const { language, links, logger, mail, templates } = options;

  return {
    async sendInvite(input: SendInviteInput): Promise<void> {
      const message = buildInviteMessage({
        clientBaseUrl: links.clientBaseUrl,
        serverPublicUrl: links.serverPublicUrl,
        inviteToken: input.inviteToken,
        expiresAt: input.expiresAt,
        language,
      });
      await postMail({
        mail,
        timeoutMs,
        outgoing: { to: input.email, subject: message.subject, text: message.text, html: message.html },
      });
      logger.info('Invitation mailed');
    },

    async sendReset(input: SendResetInput): Promise<void> {
      const message = buildResetMessage({
        clientBaseUrl: links.clientBaseUrl,
        serverPublicUrl: links.serverPublicUrl,
        resetToken: input.resetToken,
        language,
      });
      await postMail({
        mail,
        timeoutMs,
        outgoing: { to: input.email, subject: message.subject, text: message.text, html: message.html },
      });
      logger.info('Password reset mailed');
    },

    async sendAccountNotice(input: SendAccountNoticeInput): Promise<void> {
      const message = buildAccountNoticeMessage({ language });
      await postMail({
        mail,
        timeoutMs,
        outgoing: { to: input.email, subject: message.subject, text: message.text, html: message.html },
      });
      // No address, and nothing that says which member's mint caused it.
      logger.info('Account notice mailed');
    },

    async sendSignupRequest(input: SendInviteInput): Promise<void> {
      const message = buildSignupRequestMessage({
        clientBaseUrl: links.clientBaseUrl,
        serverPublicUrl: links.serverPublicUrl,
        inviteToken: input.inviteToken,
        expiresAt: input.expiresAt,
        language,
      });
      await postMail({
        mail,
        timeoutMs,
        outgoing: { to: input.email, subject: message.subject, text: message.text, html: message.html },
      });
      logger.info('Sign-up letter mailed');
    },

    async sendSignupAccountNotice(input: SendAccountNoticeInput): Promise<void> {
      const message = buildSignupAccountNoticeMessage({ language });
      await postMail({
        mail,
        timeoutMs,
        outgoing: { to: input.email, subject: message.subject, text: message.text, html: message.html },
      });
      logger.info('Sign-up account notice mailed');
    },

    async sendDeclarationReceipt(input: SendDeclarationReceiptInput): Promise<void> {
      // The reader's language first, then English, CONTRACT.md section 6.
      const template = await templates.find({
        name: receiptTemplateName(input.kind),
        languages: input.language === 'en' ? ['en'] : [input.language, 'en'],
      });
      const message = buildDeclarationReceiptMessage({ declaration: input, template });
      await postMail({
        mail,
        timeoutMs,
        outgoing: { to: input.to, subject: message.subject, text: message.text, html: message.html },
      });
      // No address and no field the person typed, for the reason the module
      // doc gives: this letter carries no link, but it carries their name,
      // their reason and their contract reference, and none of that belongs
      // in a log line either.
      logger.info('Declaration receipt mailed', { kind: input.kind, text: message.origin });
    },

    async sendDeclarationOperatorAlert(input: SendDeclarationOperatorAlertInput): Promise<void> {
      const template = await templates.find({ name: alertTemplateName(input.kind), languages: ['en'] });
      const message = buildDeclarationOperatorAlertMessage({ declaration: input, template });
      await postMail({
        mail,
        timeoutMs,
        outgoing: { to: mail.operatorEmail, subject: message.subject, text: message.text, html: message.html },
      });
      logger.info('Declaration operator alert mailed', {
        kind: input.kind,
        matched: input.matched,
        text: message.origin,
      });
    },
  };
}

/**
 * Picks the adapter from config. `null` is the copy-link-only deployment,
 * which is what most self-hosters run.
 */
export function createMailer(options: {
  mail: HttpMailConfig | null;
  links: { clientBaseUrl: string; serverPublicUrl: string } | null;
  language: InstanceLanguage;
  templates: DeclarationTemplateSource;
  logger: Logger;
}): Mailer {
  // Both or neither: `config.ts` refuses to boot with mail configured and no
  // link bases, so this branch is a type narrowing rather than a policy.
  if (options.mail === null || options.links === null) return createNoopMailer();
  return createHttpMailer({
    mail: options.mail,
    links: options.links,
    language: options.language,
    templates: options.templates,
    logger: options.logger,
  });
}
