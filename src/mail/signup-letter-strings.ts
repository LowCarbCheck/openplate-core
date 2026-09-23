/**
 * The two letters of the open sign-up door (M253), in the six languages the
 * other letters exist in.
 *
 * WHY NOT THE INVITATION. A person who asked for an account with their own
 * address was not invited by anybody. The invitation says "You are invited"
 * and "ask the person who sent it to you", and the account notice says
 * "Someone invited you": both would tell this reader something false. These
 * letters say what happened (you, or someone using your address, asked), what
 * the one link does, when it stops working, and that ignoring the mail
 * changes nothing.
 *
 * A SEPARATE DICTIONARY FROM `strings.ts`, on purpose. The four generated
 * modules there are rebuilt from a translation memory by
 * `pnpm translate:mail`, and a key added to `MailStrings` would have to appear
 * in every one of them before the English is judged. This dictionary carries
 * its own list of what is still English, which is what the architect's
 * wordsmith pass fills.
 *
 * THE RULES OF `strings.ts` HOLD HERE TOO, and `tests/unit/mail-messages.test.ts`
 * holds these letters to them: no service is named, no dash, and every
 * paragraph is an instruction or a fact about the link.
 */
import type { InstanceLanguage } from '../protocol.js';

/** The letter to a new address that asked for an account. It carries the one link that creates it. */
export interface SignupRequestStrings {
  subject: string;
  greeting: string;
  /** Why this letter arrived: this address asked for an account. */
  asked: string;
  /** What to do: open the link, which follows this paragraph. */
  open: string;
  /** Carries `{date}`, filled with the expiry rendered in the reader's language. */
  expiry: string;
  password: string;
  /** What happens if they did not ask: nothing. */
  ignore: string;
  help: string;
}

/** The letter to an address that asked and already holds an account. No link. */
export interface SignupAccountNoticeStrings {
  subject: string;
  greeting: string;
  /** Why this letter arrived, and that no second account was made. */
  asked: string;
  signIn: string;
  forgotten: string;
  ignore: string;
}

export interface SignupLetterStrings {
  request: SignupRequestStrings;
  accountNotice: SignupAccountNoticeStrings;
}

/** The English, hand-written, and the source every other language translates. */
const SIGNUP_LETTERS_EN: SignupLetterStrings = {
  request: {
    subject: 'Create your openplate account',
    greeting: 'Hello,',
    asked:
      'You, or someone using this email address, asked to create an openplate account. openplate is a food diary that keeps your data on your own device.',
    open: 'To create the account, open this link on the device you want to use openplate on:',
    expiry: 'The link works one time only, and it expires on {date}.',
    password:
      'On that page you choose a password. From then on you sign in with your email address and this password, on any device.',
    ignore: 'If you did not ask for this, you can ignore this mail. No account is created, and nothing else happens.',
    help: 'If the link no longer works, ask for a new one on the sign-up page.',
  },
  accountNotice: {
    subject: 'You already have an openplate account',
    greeting: 'Hello,',
    asked:
      'You, or someone using this email address, asked to create an openplate account. This address already has an account, so no new one was created.',
    signIn: 'Sign in with this email address and your password.',
    forgotten: 'If you forgot your password, request a new one on the sign-in page.',
    ignore: 'If you did not ask for this, you can ignore this mail. Nothing has changed.',
  },
};

/**
 * THE LANGUAGES WHOSE ENTRY BELOW IS STILL THE ENGLISH, and the one place that
 * says so. Each one is a placeholder until the wordsmith pass (Gemini 3.8
 * Flash, the workspace prose judge; German in the app's du register) returns
 * its translation, which replaces the `SIGNUP_LETTERS_EN` reference for that
 * language and removes it from this list.
 *
 * `tests/unit/mail-messages.test.ts` holds the list to the dictionary both
 * ways: a language on it must still be the English, and a language off it must
 * not be, so a translation cannot land without the list shrinking and the list
 * cannot shrink without a translation.
 */
export const SIGNUP_LETTERS_AWAITING_TRANSLATION: readonly InstanceLanguage[] = ['de', 'fr', 'it', 'es', 'tr'];

export const SIGNUP_LETTER_STRINGS = {
  en: SIGNUP_LETTERS_EN,
  // AWAITING TRANSLATION, every one: see `SIGNUP_LETTERS_AWAITING_TRANSLATION`.
  de: SIGNUP_LETTERS_EN,
  fr: SIGNUP_LETTERS_EN,
  it: SIGNUP_LETTERS_EN,
  es: SIGNUP_LETTERS_EN,
  tr: SIGNUP_LETTERS_EN,
} satisfies Record<InstanceLanguage, SignupLetterStrings>;
