import nodemailer from 'nodemailer'
import type { Settings } from '../types'

// gmail-auth is loaded lazily via `await import(...)` inside the Gmail
// helpers below so the mailer module doesn't drag cloud/config (with its
// Vite-baked __GOOGLE_CLIENT_ID__ defines) into unit-test contexts that
// only exercise the SMTP path.

function esc(str: unknown): string {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] ?? m)
  )
}

const LOCALE_MAP: Record<string, string> = {
  no: 'nb-NO', en: 'en-GB', de: 'de-DE', sv: 'sv-SE', da: 'da-DK', pl: 'pl-PL', fr: 'fr-FR'
}

interface MailStrings {
  subject:     (church: string, date: string) => string
  greeting:    (name: string) => string
  intro:       (church: string) => string
  errorLabel:  string
  dateLabel:   string
  instruction: string
  signoff:     string
}

const MAIL_STRINGS: Record<string, MailStrings> = {
  no: {
    subject:     (c, d) => `⚠️ Opptaksfeil — ${c} — ${d}`,
    greeting:    n => `Hei ${n},`,
    intro:       c => `Det oppstod en feil under planlagt opptak hos ${c}:`,
    errorLabel:  'Feil',
    dateLabel:   'Dato',
    instruction: 'Vennligst sjekk at lydmikseren er koblet til og prøv et manuelt opptak.',
    signoff:     'Hilsen SundayRec'
  },
  en: {
    subject:     (c, d) => `⚠️ Recording error — ${c} — ${d}`,
    greeting:    n => `Hello ${n},`,
    intro:       c => `An error occurred during the scheduled recording at ${c}:`,
    errorLabel:  'Error',
    dateLabel:   'Date',
    instruction: 'Please check that the audio mixer is connected and try a manual recording.',
    signoff:     'Regards, SundayRec'
  },
  de: {
    subject:     (c, d) => `⚠️ Aufnahmefehler — ${c} — ${d}`,
    greeting:    n => `Hallo ${n},`,
    intro:       c => `Bei der geplanten Aufnahme in ${c} ist ein Fehler aufgetreten:`,
    errorLabel:  'Fehler',
    dateLabel:   'Datum',
    instruction: 'Bitte prüfen Sie, ob das Audiomischpult angeschlossen ist, und versuchen Sie eine manuelle Aufnahme.',
    signoff:     'Mit freundlichen Grüßen, SundayRec'
  },
  sv: {
    subject:     (c, d) => `⚠️ Inspelningsfel — ${c} — ${d}`,
    greeting:    n => `Hej ${n},`,
    intro:       c => `Ett fel uppstod vid den schemalagda inspelningen hos ${c}:`,
    errorLabel:  'Fel',
    dateLabel:   'Datum',
    instruction: 'Kontrollera att ljudmixern är ansluten och försök med en manuell inspelning.',
    signoff:     'Vänliga hälsningar, SundayRec'
  },
  da: {
    subject:     (c, d) => `⚠️ Optagelsesfejl — ${c} — ${d}`,
    greeting:    n => `Hej ${n},`,
    intro:       c => `Der opstod en fejl under den planlagte optagelse hos ${c}:`,
    errorLabel:  'Fejl',
    dateLabel:   'Dato',
    instruction: 'Kontroller venligst at lydmixeren er tilsluttet og prøv en manuel optagelse.',
    signoff:     'Venlig hilsen, SundayRec'
  },
  pl: {
    subject:     (c, d) => `⚠️ Błąd nagrywania — ${c} — ${d}`,
    greeting:    n => `Witaj ${n},`,
    intro:       c => `Wystąpił błąd podczas zaplanowanego nagrania w ${c}:`,
    errorLabel:  'Błąd',
    dateLabel:   'Data',
    instruction: 'Sprawdź, czy mikser audio jest podłączony i spróbuj nagrać ręcznie.',
    signoff:     'Pozdrowienia, SundayRec'
  },
  fr: {
    subject:     (c, d) => `⚠️ Erreur d'enregistrement — ${c} — ${d}`,
    greeting:    n => `Bonjour ${n},`,
    intro:       c => `Une erreur s'est produite lors de l'enregistrement planifié à ${c} :`,
    errorLabel:  'Erreur',
    dateLabel:   'Date',
    instruction: "Veuillez vérifier que la console audio est connectée et essayez un enregistrement manuel.",
    signoff:     'Cordialement, SundayRec'
  }
}

const TEST_STRINGS: Record<string, { subject: string; body: string }> = {
  no: { subject: '✓ SundayRec — e-post fungerer', body: 'E-postkonfigurasjonen er korrekt. Dette er en testmelding fra SundayRec.' },
  en: { subject: '✓ SundayRec — email works',     body: 'Email configuration is correct. This is a test message from SundayRec.' },
  de: { subject: '✓ SundayRec — E-Mail funktioniert', body: 'Die E-Mail-Konfiguration ist korrekt. Dies ist eine Testnachricht von SundayRec.' },
  sv: { subject: '✓ SundayRec — e-post fungerar', body: 'E-postkonfigurationen är korrekt. Detta är ett testmeddelande från SundayRec.' },
  da: { subject: '✓ SundayRec — e-mail virker',   body: 'E-mailkonfigurationen er korrekt. Dette er en testbesked fra SundayRec.' },
  pl: { subject: '✓ SundayRec — e-mail działa',   body: 'Konfiguracja e-mail jest poprawna. To jest wiadomość testowa z SundayRec.' },
  fr: { subject: "✓ SundayRec — e-mail fonctionne", body: "La configuration e-mail est correcte. C'est un message test de SundayRec." }
}

export async function sendTest(settings: Settings, smtpPass: string): Promise<void> {
  if (!settings.emailAddress) throw new Error('no_config')

  const ts = TEST_STRINGS[settings.language ?? 'no'] ?? TEST_STRINGS.no

  // Prefer Gmail OAuth when connected — no SMTP server, no app-password,
  // no port juggling. Falls through to SMTP only when the user has
  // chosen the advanced path explicitly.
  if (await canUseGmailOAuth(settings)) {
    await sendViaGmail({
      to:      settings.emailAddress,
      subject: ts.subject,
      text:    ts.body,
      html:    undefined,
    })
    return
  }

  if (!settings.emailSmtp) throw new Error('no_config')
  const transporter = nodemailer.createTransport({
    host: settings.emailSmtp,
    port: settings.emailSmtpPort || 587,
    secure: settings.emailSmtpPort === 465,
    connectionTimeout: 10000,
    greetingTimeout:    5000,
    socketTimeout:     10000,
    auth: settings.emailSmtpUser
      ? { user: settings.emailSmtpUser, pass: smtpPass }
      : undefined
  })
  const from = (settings as { emailFrom?: string }).emailFrom?.trim() || settings.emailSmtpUser || 'noreply@sundayrec.app'
  await transporter.sendMail({
    from: `"SundayRec" <${from}>`,
    to: settings.emailAddress,
    subject: ts.subject,
    text: ts.body
  })
}

export async function sendError(settings: Settings, smtpPass: string, errorMessage: string): Promise<void> {
  if (!settings.emailAddress) return

  // Build content first — it's identical whether we send via Gmail or SMTP.
  const lang    = settings.language ?? 'no'
  const strings = MAIL_STRINGS[lang] ?? MAIL_STRINGS.no
  const locale  = LOCALE_MAP[lang] ?? 'nb-NO'
  const church  = settings.churchName || 'SundayRec'
  const person  = settings.responsiblePerson || ''
  const date    = new Date().toLocaleDateString(locale, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  })

  const subject  = strings.subject(church, date)
  const greeting = strings.greeting(person)
  const intro    = strings.intro(church)

  const textBody = [
    greeting,
    '',
    intro,
    '',
    `${strings.errorLabel}: ${errorMessage}`,
    `${strings.dateLabel}: ${date}`,
    '',
    strings.instruction,
    '',
    strings.signoff
  ].join('\n')

  const htmlBody = `
    <p>${esc(greeting)}</p>
    <p>${esc(intro)}</p>
    <blockquote style="background:#fee;padding:12px;border-left:4px solid #f05;">
      <strong>${esc(strings.errorLabel)}:</strong> ${esc(errorMessage)}<br>
      <strong>${esc(strings.dateLabel)}:</strong> ${esc(date)}
    </blockquote>
    <p>${esc(strings.instruction)}</p>
    <p>${esc(strings.signoff)}</p>
  `

  // Prefer Gmail OAuth — see sendTest() for the rationale.
  if (await canUseGmailOAuth(settings)) {
    try {
      await sendViaGmail({
        to:      settings.emailAddress,
        subject,
        text:    textBody,
        html:    htmlBody,
      })
    } catch (err) {
      console.error('Failed to send error email via Gmail OAuth:', (err as Error).message)
    }
    return
  }

  if (!settings.emailSmtp) return
  const transporter = nodemailer.createTransport({
    host: settings.emailSmtp,
    port: settings.emailSmtpPort || 587,
    secure: settings.emailSmtpPort === 465,
    connectionTimeout: 10000,
    greetingTimeout:    5000,
    socketTimeout:     10000,
    auth: settings.emailSmtpUser
      ? { user: settings.emailSmtpUser, pass: smtpPass }
      : undefined
  })

  const from = (settings as { emailFrom?: string }).emailFrom?.trim() || settings.emailSmtpUser || 'noreply@sundayrec.app'
  try {
    await transporter.sendMail({
      from: `"SundayRec" <${from}>`,
      to: settings.emailAddress,
      subject,
      text: textBody,
      html: htmlBody,
    })
  } catch (err) {
    console.error('Failed to send error email:', (err as Error).message)
  }
}

// ─── Gmail OAuth send path ──────────────────────────────────────────────────
//
// Bypass SMTP entirely when the user has connected their Google account via
// the "Logg inn med Google"-knapp on the e-mail-notifications card. The API
// is dead simple — base64url-encode an RFC 2822 message and POST it.

async function canUseGmailOAuth(settings: Settings): Promise<boolean> {
  // The user can explicitly pin email transport to SMTP in settings; respect
  // that choice even if a Gmail token happens to exist.
  if ((settings as { emailTransport?: string }).emailTransport === 'smtp') return false
  try {
    const { getGmailStatus } = await import('./cloud/gmail-auth')
    return getGmailStatus().connected
  } catch {
    // cloud module unavailable (e.g. test context without electron mocks)
    return false
  }
}

interface GmailSendArgs {
  to:      string
  subject: string
  text:    string
  html?:   string
}

async function sendViaGmail(args: GmailSendArgs): Promise<void> {
  const { getFreshGmailAccessToken, getGmailStatus } = await import('./cloud/gmail-auth')
  const token = await getFreshGmailAccessToken()
  if (!token) throw new Error('gmail-not-authenticated')

  const status = getGmailStatus()
  const from = status.email ? `"SundayRec" <${status.email}>` : '"SundayRec" <me>'

  // RFC 2822 message — multipart/alternative when we have HTML, plain
  // otherwise. We hand-roll this so we don't need to pull in nodemailer's
  // compile() pipeline; Gmail just needs a valid raw message.
  let mime: string
  if (args.html) {
    const boundary = `sundayrec-${Date.now().toString(36)}`
    mime = [
      `From: ${from}`,
      `To: ${args.to}`,
      `Subject: ${encodeRfc2047Subject(args.subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      args.text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      args.html,
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n')
  } else {
    mime = [
      `From: ${from}`,
      `To: ${args.to}`,
      `Subject: ${encodeRfc2047Subject(args.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      args.text,
      '',
    ].join('\r\n')
  }

  // base64url per Gmail API spec — standard base64 with - / instead of + /
  // and trailing = stripped.
  const raw = Buffer.from(mime, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ raw }),
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`Gmail send failed: ${r.status} ${txt.slice(0, 200)}`)
  }
}

/** Encode a Subject header that may contain non-ASCII characters. RFC 2047
 *  "B-encoding" wraps the value in =?UTF-8?B?<base64>?= so emoji and Norwegian
 *  letters in our localized subject strings reach the recipient intact. */
function encodeRfc2047Subject(subject: string): string {
  // Pure-ASCII subjects pass through untouched — common case for English.
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(subject)) return subject
  const b64 = Buffer.from(subject, 'utf8').toString('base64')
  return `=?UTF-8?B?${b64}?=`
}
