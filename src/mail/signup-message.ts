/**
 * The two letters of the open sign-up door (M253), as PURE FUNCTIONS of their
 * inputs, for the reasons `invite-message.ts` gives: the link is checked by
 * string comparison, and nothing here is tempted to log what it built.
 *
 * THE LINK IS THE INVITATION'S LINK. What the person redeems is an ordinary
 * addressed invite (PROTOCOL.md §5.8.3), so the grammar is `/join#server=...&
 * invite=si_...`, built by the same `buildInviteLink`. Only the words differ.
 */
import type { InstanceLanguage } from '../protocol.js';
import type { AccountNoticeMessage } from './account-notice-message.js';
import { buildInviteLink, renderHtml, type BuiltMessage } from './invite-message.js';
import { SIGNUP_LETTER_STRINGS } from './signup-letter-strings.js';
import { fill, formatExpiryDate } from './strings.js';

export interface SignupRequestMessageInput {
  clientBaseUrl: string;
  serverPublicUrl: string;
  /** The plaintext `si_` token. A credential: never logged. */
  inviteToken: string;
  expiresAt: string;
  language: InstanceLanguage;
}

/**
 * PARAGRAPH ORDER: greeting, asked, open, the link, expiry, password, ignore,
 * help. Why it arrived comes first, the link sits right after the sentence
 * that says to open it, and what happens if they ignore it comes before the
 * one thing that can go wrong.
 */
export function buildSignupRequestMessage(input: SignupRequestMessageInput): BuiltMessage {
  const strings = SIGNUP_LETTER_STRINGS[input.language].request;
  const link = buildInviteLink({
    clientBaseUrl: input.clientBaseUrl,
    serverPublicUrl: input.serverPublicUrl,
    inviteToken: input.inviteToken,
  });
  const expiry = fill(strings.expiry, {
    date: formatExpiryDate({ expiresAt: input.expiresAt, language: input.language }),
  });
  const before = [strings.greeting, strings.asked, strings.open];
  const after = [expiry, strings.password, strings.ignore, strings.help];
  return {
    subject: strings.subject,
    text: [...before, link, ...after].join('\n\n'),
    html: renderHtml({ language: input.language, before, after, link }),
    link,
  };
}

/**
 * The note to an address that asked and already holds an account. NO LINK,
 * for the reason the account notice carries none: a join link would make a
 * second account and a reset link would be a reset nobody asked for.
 */
export function buildSignupAccountNoticeMessage(input: { language: InstanceLanguage }): AccountNoticeMessage {
  const strings = SIGNUP_LETTER_STRINGS[input.language].accountNotice;
  const before = [strings.greeting, strings.asked, strings.signIn, strings.forgotten, strings.ignore];
  return {
    subject: strings.subject,
    text: before.join('\n\n'),
    html: renderHtml({ language: input.language, before, after: [], link: null }),
  };
}
