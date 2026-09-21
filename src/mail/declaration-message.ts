/**
 * The two letters `server/legal-declarations.ts` sends, as PURE FUNCTIONS of
 * their inputs, beside `reset-message.ts`.
 *
 * TWO LANGUAGES, NOT SIX, AND DELIBERATELY SEPARATE FROM `strings.ts`.
 * `MAIL_STRINGS` is keyed by `InstanceLanguage`, and a key added there has to
 * exist in all six of that type's languages or the file does not compile. The
 * request body this route accepts carries `language: "de" | "en"` and no
 * other value, per PROTOCOL — the PWA's two statutory buttons are German
 * legal instruments and the reader chose one of exactly two languages on the
 * form. Folding a two-language feature into the six-language dictionary would
 * mean inventing `fr`/`it`/`es`/`tr` copy for a request shape that can never
 * carry them; a dictionary of its own says so directly.
 *
 * THE RECEIPT IS THE ONLY ONE THAT IS TRANSLATED. `buildDeclarationReceiptMessage`
 * goes to the person who filed the declaration, in the language they chose.
 * `buildDeclarationOperatorAlertMessage` goes to the operator, in English only:
 * it is an operational notice about a compliance deadline, not a letter to a
 * consumer, and it is the one message in this module with no reviewed German
 * text to fall back on.
 *
 * NEITHER LETTER NAMES A SERVICE, A GATEWAY OR AN ACCOUNT LINK, the same rule
 * `strings.ts` states for every other letter this service sends, and neither
 * carries an em dash or an en dash. `tests/unit/declaration-message.test.ts`
 * holds both to it.
 *
 * THE GERMAN RECEIPT TEXT WAS PRODUCED BY THE WORKSPACE'S WORDSMITH PASS
 * (`google/gemini-3.8-flash`, 2026-09-21) FROM THE ENGLISH BELOW, exactly as
 * `strings.ts`'s `en`/`de` were. Changing a sentence means running that pass
 * again and pasting the result, not rewriting it here by hand.
 */
import { renderHtml } from './invite-message.js';

export type DeclarationLanguage = 'de' | 'en';

export type DeclarationKind = 'kuendigung' | 'widerruf';

/** Every field the person could have typed, exactly as `legal_declarations` stores them. `null` means the field was left out, not that it was blank. */
export interface DeclarationFields {
  kind: DeclarationKind;
  name: string;
  email: string;
  contractReference: string | null;
  terminationType: 'ordentlich' | 'ausserordentlich' | null;
  reason: string | null;
  requestedDate: string | null;
  timing: 'earliest' | 'onDate' | null;
  /** This service's own clock at the moment the row was written, rendered in Europe/Berlin with its offset. */
  receivedAt: Date;
}

export interface BuiltDeclarationMessage {
  subject: string;
  text: string;
  html: string;
}

interface DeclarationReceiptStrings {
  subjectKuendigung: string;
  subjectWiderruf: string;
  greeting: string;
  /** Carries `{date}`. */
  introKuendigung: string;
  /** Carries `{date}`. */
  introWiderruf: string;
  fieldsHeading: string;
  labelName: string;
  labelEmail: string;
  labelContractReference: string;
  labelTerminationType: string;
  labelReason: string;
  labelRequestedDate: string;
  labelTiming: string;
  terminationTypeOrdentlich: string;
  terminationTypeAusserordentlich: string;
  timingEarliest: string;
  timingOnDate: string;
  outcomeKuendigung: string;
  outcomeWiderruf: string;
}

/**
 * The receipt, in both languages the wire contract accepts. `en` is the
 * hand-written source of truth; `de` is that text through the workspace
 * wordsmith pass, formal `Sie`, reviewed and pasted, not composed here.
 */
const DECLARATION_RECEIPT_STRINGS = {
  en: {
    subjectKuendigung: 'Your cancellation request',
    subjectWiderruf: 'Your withdrawal',
    greeting: 'Hello,',
    introKuendigung: 'We received your cancellation request on {date}.',
    introWiderruf: 'We received your withdrawal on {date}.',
    fieldsHeading: 'You gave us these details:',
    labelName: 'Name',
    labelEmail: 'Email',
    labelContractReference: 'Contract or customer number',
    labelTerminationType: 'Type of cancellation',
    labelReason: 'Reason',
    labelRequestedDate: 'Requested date',
    labelTiming: 'Timing',
    terminationTypeOrdentlich: 'regular notice',
    terminationTypeAusserordentlich: 'extraordinary notice',
    timingEarliest: 'as soon as legally possible',
    timingOnDate: 'on the date you gave',
    outcomeKuendigung:
      'Your cancellation takes effect at the end of your current paid period. You keep full access until then.',
    outcomeWiderruf: 'A person on our team will look at this and get back to you within 14 days.',
  },
  de: {
    subjectKuendigung: 'Ihre Kündigung',
    subjectWiderruf: 'Ihr Widerruf',
    greeting: 'Guten Tag,',
    introKuendigung: 'Wir haben Ihre Kündigung am {date} erhalten.',
    introWiderruf: 'Wir haben Ihren Widerruf am {date} erhalten.',
    fieldsHeading: 'Sie haben folgende Angaben gemacht:',
    labelName: 'Name',
    labelEmail: 'E-Mail',
    labelContractReference: 'Vertrags- oder Kundennummer',
    labelTerminationType: 'Art der Kündigung',
    labelReason: 'Grund',
    labelRequestedDate: 'Gewünschtes Datum',
    labelTiming: 'Zeitpunkt',
    terminationTypeOrdentlich: 'ordentliche Kündigung',
    terminationTypeAusserordentlich: 'außerordentliche Kündigung',
    timingEarliest: 'zum nächstmöglichen Zeitpunkt',
    timingOnDate: 'zum angegebenen Datum',
    outcomeKuendigung:
      'Ihre Kündigung wird zum Ende Ihres aktuellen Abrechnungszeitraums wirksam. Bis dahin behalten Sie den vollen Zugriff.',
    outcomeWiderruf: 'Wir prüfen Ihre Angaben und melden uns innerhalb von 14 Tagen bei Ihnen.',
  },
} satisfies Record<DeclarationLanguage, DeclarationReceiptStrings>;

/** The `Intl` locale each language's date is rendered in, mirroring `strings.ts`'s `DATE_LOCALES` for the two languages this module carries. */
const RECEIPT_DATE_LOCALES = {
  en: 'en-GB',
  de: 'de-DE',
} satisfies Record<DeclarationLanguage, string>;

/**
 * The received instant, in Europe/Berlin with its offset name attached.
 *
 * EUROPE/BERLIN, NEVER UTC, unlike `strings.ts`'s expiry dates: those are a
 * day-granular deadline where the zone rarely matters, this is "the date and
 * time of receipt" that both statutes require the acknowledgement to state,
 * and the business, the statute and the reader are all in the same zone.
 */
function formatReceivedAt(input: { receivedAt: Date; language: DeclarationLanguage }): string {
  // Explicit components rather than `dateStyle`/`timeStyle`: `Intl.DateTimeFormat`
  // refuses to combine either style shorthand with `timeZoneName`, and the
  // offset name is the one thing both statutes require the acknowledgement
  // to carry.
  return new Intl.DateTimeFormat(RECEIPT_DATE_LOCALES[input.language], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin',
    timeZoneName: 'short',
  }).format(input.receivedAt);
}

/** Substitutes the one `{date}` placeholder either intro carries. */
function fillDate(template: string, date: string): string {
  return template.replace('{date}', date);
}

/** One "Label: value" line, or nothing when the field was not given. */
function detailLine(label: string, value: string | null): string[] {
  return value === null ? [] : [`${label}: ${value}`];
}

function terminationTypeLabel(strings: DeclarationReceiptStrings, value: 'ordentlich' | 'ausserordentlich'): string {
  return value === 'ordentlich' ? strings.terminationTypeOrdentlich : strings.terminationTypeAusserordentlich;
}

function timingLabel(strings: DeclarationReceiptStrings, value: 'earliest' | 'onDate'): string {
  return value === 'earliest' ? strings.timingEarliest : strings.timingOnDate;
}

/** Every field line the person's own submission earns, in the fixed order the form asked for them. */
function detailLines(strings: DeclarationReceiptStrings, fields: DeclarationFields): string[] {
  return [
    ...detailLine(strings.labelName, fields.name),
    ...detailLine(strings.labelEmail, fields.email),
    ...detailLine(strings.labelContractReference, fields.contractReference),
    ...detailLine(
      strings.labelTerminationType,
      fields.terminationType === null ? null : terminationTypeLabel(strings, fields.terminationType),
    ),
    ...detailLine(strings.labelReason, fields.reason),
    ...detailLine(strings.labelRequestedDate, fields.requestedDate),
    ...detailLine(strings.labelTiming, fields.timing === null ? null : timingLabel(strings, fields.timing)),
  ];
}

/**
 * PARAGRAPH ORDER: greeting, what was received and when, every field the
 * person typed, and last the one fact that matters most to them, when this
 * takes effect or when they hear back. Nothing after it: no offer, no pause,
 * no survey, no support link, the same bound the confirmation page holds to.
 */
export function buildDeclarationReceiptMessage(
  input: DeclarationFields & { language: DeclarationLanguage },
): BuiltDeclarationMessage {
  const strings = DECLARATION_RECEIPT_STRINGS[input.language];
  const date = formatReceivedAt({ receivedAt: input.receivedAt, language: input.language });
  const intro = fillDate(
    input.kind === 'kuendigung' ? strings.introKuendigung : strings.introWiderruf,
    date,
  );
  const outcome = input.kind === 'kuendigung' ? strings.outcomeKuendigung : strings.outcomeWiderruf;
  const subject = input.kind === 'kuendigung' ? strings.subjectKuendigung : strings.subjectWiderruf;

  const before = [strings.greeting, intro, strings.fieldsHeading, ...detailLines(strings, input)];
  const after = [outcome];

  return {
    subject,
    text: [...before, ...after].join('\n\n'),
    html: renderHtml({ language: input.language, before, after, link: null }),
  };
}

// ── The operator alert ───────────────────────────────────────────────────
// English only. See the module header for why.

const OPERATOR_KIND_LABEL = {
  kuendigung: 'Cancellation (section 312k BGB)',
  widerruf: 'Withdrawal (section 356a BGB)',
} satisfies Record<DeclarationKind, string>;

export interface DeclarationOperatorAlertInput extends DeclarationFields {
  /** The same id the person's own receipt carries, so an operator can find the row this letter is about. */
  receiptId: string;
  /** Whether the email matched an account on this instance. Never the account id: this letter is a notice, not a lookup tool. */
  matched: boolean;
}

/** Europe/Berlin, English formatting, for the operator's own reading rather than the reader's. */
function formatOperatorReceivedAt(receivedAt: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin',
    timeZoneName: 'short',
  }).format(receivedAt);
}

const OPERATOR_EN: DeclarationReceiptStrings = DECLARATION_RECEIPT_STRINGS.en;

/**
 * PARAGRAPH ORDER: what arrived and when, the receipt id, every field, and
 * last whether it matched an account, because that is the one fact that
 * changes what the operator does next: look up a subscription, or take the
 * request at its word.
 */
export function buildDeclarationOperatorAlertMessage(input: DeclarationOperatorAlertInput): BuiltDeclarationMessage {
  const date = formatOperatorReceivedAt(input.receivedAt);
  const subject = `New declaration: ${input.kind === 'kuendigung' ? 'cancellation' : 'withdrawal'} (${input.receiptId})`;
  const intro = `${OPERATOR_KIND_LABEL[input.kind]} received on ${date}. Receipt ID: ${input.receiptId}.`;
  const matchLine = `Matched to an existing account: ${input.matched ? 'yes' : 'no'}.`;

  const before = [intro, 'The person gave these details:', ...detailLines(OPERATOR_EN, input), matchLine];

  return {
    subject,
    text: before.join('\n\n'),
    html: renderHtml({ language: 'en', before, after: [], link: null }),
  };
}
