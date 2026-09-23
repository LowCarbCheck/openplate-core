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

/** German, bought from the wordsmith pass (Gemini 3.8 Flash) in the app's du register. */
const SIGNUP_LETTERS_DE: SignupLetterStrings = {
  request: {
    subject: 'Erstelle dein openplate-Konto',
    greeting: 'Hallo,',
    asked:
      'Du oder jemand mit dieser E-Mail-Adresse möchte ein openplate-Konto erstellen. openplate ist ein Ernährungstagebuch, das deine Daten auf deinem eigenen Gerät speichert.',
    open: 'Um das Konto zu erstellen, öffne diesen Link auf dem Gerät, auf dem du openplate nutzen möchtest:',
    expiry: 'Der Link funktioniert nur einmal und läuft am {date} ab.',
    password:
      'Auf dieser Seite wählst du ein Passwort aus. Danach meldest du dich auf jedem Gerät mit deiner E-Mail-Adresse und diesem Passwort an.',
    ignore:
      'Wenn du das nicht angefragt hast, kannst du diese E-Mail ignorieren. Es wird kein Konto erstellt und es passiert weiter nichts.',
    help: 'Wenn der Link nicht mehr funktioniert, fordere auf der Registrierungsseite einfach einen neuen an.',
  },
  accountNotice: {
    subject: 'Du hast bereits ein openplate-Konto',
    greeting: 'Hallo,',
    asked:
      'Du oder jemand mit dieser E-Mail-Adresse möchte ein openplate-Konto erstellen. Für diese Adresse existiert bereits ein Konto, daher wurde kein neues erstellt.',
    signIn: 'Melde dich einfach mit dieser E-Mail-Adresse und deinem Passwort an.',
    forgotten: 'Wenn du dein Passwort vergessen hast, fordere auf der Anmeldeseite ein neues an.',
    ignore: 'Wenn du das nicht angefragt hast, kannst du diese E-Mail ignorieren. Es hat sich nichts geändert.',
  },
};

/** French, bought from the wordsmith pass (Gemini 3.8 Flash) in the app's tu register. */
const SIGNUP_LETTERS_FR: SignupLetterStrings = {
  request: {
    subject: 'Crée ton compte openplate',
    greeting: 'Bonjour,',
    asked:
      "Toi ou quelqu'un utilisant cette adresse e-mail a demandé à créer un compte openplate. openplate est un journal alimentaire qui conserve tes données sur ton propre appareil.",
    open: "Pour créer ton compte, ouvre ce lien sur l'appareil avec lequel tu souhaites utiliser openplate :",
    expiry: "Ce lien n'est valable qu'une seule fois et expire le {date}.",
    password:
      "Sur cette page, choisis un mot de passe. Tu pourras ensuite te connecter avec ton adresse e-mail et ce mot de passe, depuis n'importe quel appareil.",
    ignore:
      "Si tu n'as pas fait cette demande, tu peux ignorer cet e-mail. Aucun compte n'est créé et rien d'autre ne se passe.",
    help: "Si le lien ne fonctionne plus, demande-en un nouveau sur la page d'inscription.",
  },
  accountNotice: {
    subject: 'Tu as déjà un compte openplate',
    greeting: 'Bonjour,',
    asked:
      "Toi ou quelqu'un utilisant cette adresse e-mail a demandé à créer un compte openplate. Un compte existe déjà avec cette adresse, aucun nouveau compte n'a donc été créé.",
    signIn: 'Connecte-toi avec cette adresse e-mail et ton mot de passe.',
    forgotten: 'Si tu as oublié ton mot de passe, demande-en un nouveau sur la page de connexion.',
    ignore: "Si tu n'as pas fait cette demande, tu peux ignorer cet e-mail. Rien n'a changé.",
  },
};

/** Italian, bought from the wordsmith pass (Gemini 3.8 Flash) in the app's tu register. */
const SIGNUP_LETTERS_IT: SignupLetterStrings = {
  request: {
    subject: 'Crea il tuo account openplate',
    greeting: 'Ciao,',
    asked:
      'Tu, o qualcuno che usa questo indirizzo email, hai chiesto di creare un account openplate. openplate è un diario alimentare che conserva i tuoi dati direttamente sul tuo dispositivo.',
    open: "Per creare l'account, apri questo link sul dispositivo su cui vuoi usare openplate:",
    expiry: 'Il link è utilizzabile una sola volta e scade il {date}.',
    password:
      'In quella pagina potrai scegliere una password. Da quel momento potrai accedere con il tuo indirizzo email e questa password, su qualsiasi dispositivo.',
    ignore:
      "Se non l'hai richiesto tu, puoi ignorare questa email. Non verrà creato alcun account e non succederà nient'altro.",
    help: 'Se il link non funziona più, puoi richiederne uno nuovo nella pagina di registrazione.',
  },
  accountNotice: {
    subject: 'Hai già un account openplate',
    greeting: 'Ciao,',
    asked:
      'Tu, o qualcuno che usa questo indirizzo email, hai chiesto di creare un account openplate. Questo indirizzo ha già un account, quindi non ne è stato creato uno nuovo.',
    signIn: 'Accedi con questo indirizzo email e la tua password.',
    forgotten: 'Se hai dimenticato la password, puoi richiederne una nuova nella pagina di accesso.',
    ignore: "Se non l'hai richiesto tu, puoi ignorare questa email. Non è cambiato nulla.",
  },
};

/** Spanish, bought from the wordsmith pass (Gemini 3.8 Flash) in the app's tú register. */
const SIGNUP_LETTERS_ES: SignupLetterStrings = {
  request: {
    subject: 'Crea tu cuenta de openplate',
    greeting: 'Hola,',
    asked:
      'Tú, o alguien con esta dirección de correo electrónico, solicitó crear una cuenta de openplate. openplate es un diario de comidas que guarda tus datos en tu propio dispositivo.',
    open: 'Para crear la cuenta, abre este enlace en el dispositivo en el que quieras usar openplate:',
    expiry: 'El enlace funciona solo una vez y caduca el {date}.',
    password:
      'En esa página eliges una contraseña. A partir de ese momento, inicias sesión con tu correo electrónico y esta contraseña en cualquier dispositivo.',
    ignore: 'Si no lo has solicitado, puedes ignorar este correo. No se creará ninguna cuenta ni ocurrirá nada más.',
    help: 'Si el enlace ya no funciona, solicita uno nuevo en la página de registro.',
  },
  accountNotice: {
    subject: 'Ya tienes una cuenta de openplate',
    greeting: 'Hola,',
    asked:
      'Tú, o alguien con esta dirección de correo electrónico, solicitó crear una cuenta de openplate. Esta dirección ya tiene una cuenta, por lo que no se ha creado ninguna nueva.',
    signIn: 'Inicia sesión con esta dirección de correo electrónico y tu contraseña.',
    forgotten: 'Si has olvidado tu contraseña, solicita una nueva en la página de inicio de sesión.',
    ignore: 'Si no lo has solicitado, puedes ignorar este correo. No ha cambiado nada.',
  },
};

/** Turkish, bought from the wordsmith pass (Gemini 3.8 Flash) in the app's informal register. */
const SIGNUP_LETTERS_TR: SignupLetterStrings = {
  request: {
    subject: 'openplate hesabını oluştur',
    greeting: 'Merhaba,',
    asked:
      'Sen veya bu e-posta adresini kullanan biri, bir openplate hesabı oluşturmak istedi. openplate, verilerini kendi cihazında saklayan bir yemek günlüğüdür.',
    open: "Hesabı oluşturmak için, openplate'i kullanmak istediğin cihazda bu bağlantıyı aç:",
    expiry: 'Bağlantı yalnızca bir kez geçerlidir ve son geçerlilik tarihi {date}.',
    password:
      'Bu sayfada bir şifre belirlersin. Sonrasında herhangi bir cihazda e-posta adresin ve bu şifreyle giriş yapabilirsin.',
    ignore:
      'Bunu sen talep etmediysen bu e-postayı görmezden gelebilirsin. Hiçbir hesap oluşturulmaz ve başka bir işlem yapılmaz.',
    help: 'Bağlantı artık çalışmıyorsa, kayıt sayfasından yeni bir bağlantı isteyebilirsin.',
  },
  accountNotice: {
    subject: 'Zaten bir openplate hesabın var',
    greeting: 'Merhaba,',
    asked:
      'Sen veya bu e-posta adresini kullanan biri, bir openplate hesabı oluşturmak istedi. Bu adrese kayıtlı bir hesap zaten var, bu yüzden yeni bir hesap oluşturulmadı.',
    signIn: 'Bu e-posta adresin ve şifrenle giriş yap.',
    forgotten: 'Şifreni unuttuysan, giriş sayfasından yeni bir şifre talep edebilirsin.',
    ignore: 'Bunu sen talep etmediysen bu e-postayı görmezden gelebilirsin. Hiçbir şey değişmedi.',
  },
};

/**
 * THE LANGUAGES WHOSE ENTRY IS STILL THE ENGLISH, and the one place that says
 * so. Empty now: the wordsmith pass (Gemini 3.8 Flash, the workspace prose
 * judge) returned all five, each one replacing its `SIGNUP_LETTERS_EN`
 * reference below.
 *
 * `tests/unit/mail-messages.test.ts` holds the list to the dictionary both
 * ways: a language on it must still be the English, and a language off it must
 * not be, so a translation cannot land without the list shrinking and the list
 * cannot shrink without a translation.
 */
export const SIGNUP_LETTERS_AWAITING_TRANSLATION: readonly InstanceLanguage[] = [];

export const SIGNUP_LETTER_STRINGS = {
  en: SIGNUP_LETTERS_EN,
  de: SIGNUP_LETTERS_DE,
  fr: SIGNUP_LETTERS_FR,
  it: SIGNUP_LETTERS_IT,
  es: SIGNUP_LETTERS_ES,
  tr: SIGNUP_LETTERS_TR,
} satisfies Record<InstanceLanguage, SignupLetterStrings>;
