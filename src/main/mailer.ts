import nodemailer from 'nodemailer'
import type { Settings } from '../types'

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

export async function sendError(settings: Settings, smtpPass: string, errorMessage: string): Promise<void> {
  if (!settings.emailAddress || !settings.emailSmtp) return

  const transporter = nodemailer.createTransport({
    host: settings.emailSmtp,
    port: settings.emailSmtpPort || 587,
    secure: settings.emailSmtpPort === 465,
    auth: settings.emailSmtpUser
      ? { user: settings.emailSmtpUser, pass: smtpPass }
      : undefined
  })

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

  try {
    await transporter.sendMail({
      from: `"SundayRec" <${settings.emailSmtpUser || 'noreply@sundayrec.app'}>`,
      to: settings.emailAddress,
      subject,
      text: [
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
      ].join('\n'),
      html: `
        <p>${esc(greeting)}</p>
        <p>${esc(intro)}</p>
        <blockquote style="background:#fee;padding:12px;border-left:4px solid #f05;">
          <strong>${esc(strings.errorLabel)}:</strong> ${esc(errorMessage)}<br>
          <strong>${esc(strings.dateLabel)}:</strong> ${esc(date)}
        </blockquote>
        <p>${esc(strings.instruction)}</p>
        <p>${esc(strings.signoff)}</p>
      `
    })
  } catch (err) {
    console.error('Failed to send error email:', (err as Error).message)
  }
}
