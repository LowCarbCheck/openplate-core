/**
 * The note somebody gets when a member invited an address that already has an
 * account (M212), as a PURE FUNCTION of its inputs.
 *
 * WHY THIS LETTER EXISTS AT ALL. `POST /v1/auth/invites` answers the same
 * `202` whether the address is new, already has a pending invitation, or
 * already holds an account, so the person who typed it learns nothing. That
 * indistinguishability is bought at the reader's expense unless something
 * arrives: without this letter, an invitation to a colleague who is already
 * here would silently go nowhere and both people would wait for it.
 *
 * IT IS THE ONE LETTER WITH NO LINK, and both alternatives are worse than
 * none. A join link would mint a second account for somebody who has one, and
 * a reset link would be a password reset nobody asked for, mailable by any
 * member who can type an address. So this message says what the reader does
 * next in their own words and hands over no capability at all.
 *
 * IT NAMES NOBODY AND NOTHING. Not the member who typed the address, because
 * the reader has no use for that and the sender must not learn the account
 * exists; and not a service, a gateway or an account link, which is the rule
 * `strings.ts` states and `tests/unit/mail-messages.test.ts` enforces.
 */
import type { InstanceLanguage } from '../protocol.js';
import { renderHtml } from './invite-message.js';
import { MAIL_STRINGS } from './strings.js';

/**
 * A built letter with no link in it. SEPARATE FROM `BuiltMessage` rather than
 * that type with a nullable field: every caller of `BuiltMessage.link` today
 * puts the URL in an admin response, and there is no URL here to put anywhere.
 */
export interface AccountNoticeMessage {
  subject: string;
  text: string;
  html: string;
}

export interface AccountNoticeMessageInput {
  /**
   * The instance's configured language (`INSTANCE_LANGUAGE`).
   *
   * An INPUT, not a module-scope read, for the reason `invite-message.ts`
   * gives: this builder stays a pure function of its arguments, so both
   * languages are asserted by string comparison with no environment and no
   * mail API anywhere near the test.
   */
  language: InstanceLanguage;
}

/**
 * PARAGRAPH ORDER IS FIXED: greeting, invited, signIn, forgotten. The reason
 * the letter arrived comes before the instruction, and the one thing that can
 * be wrong for the reader comes last, exactly where the reset letter puts its
 * own `help`.
 */
export function buildAccountNoticeMessage(input: AccountNoticeMessageInput): AccountNoticeMessage {
  const strings = MAIL_STRINGS[input.language].accountNotice;
  // Built once and used by both parts, so the two can never disagree about
  // what the reader was told.
  const before = [strings.greeting, strings.invited, strings.signIn, strings.forgotten];

  return {
    subject: strings.subject,
    text: before.join('\n\n'),
    // `link: null` is what omits the anchor paragraph; see `renderHtml`.
    html: renderHtml({ language: input.language, before, after: [], link: null }),
  };
}
