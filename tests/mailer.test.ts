const mockSendMail = jest.fn()

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: mockSendMail,
  })),
}))

import nodemailer from 'nodemailer'
import { sendTest, sendError } from '../src/main/mailer'
import type { Settings } from '../src/types'

const BASE_SETTINGS: Settings = {
  language:          'en',
  emailAddress:      'test@example.com',
  emailSmtp:         'smtp.example.com',
  emailSmtpPort:     587,
  emailSmtpUser:     'user@example.com',
  churchName:        'Test Church',
  responsiblePerson: 'Alice',
} as unknown as Settings

// ─── module smoke test ────────────────────────────────────────────────────────

describe('mailer module', () => {
  it('exports sendTest as a function', () => {
    expect(typeof sendTest).toBe('function')
  })

  it('exports sendError as a function', () => {
    expect(typeof sendError).toBe('function')
  })
})

// ─── esc (HTML escaping) tested via sendError html output ─────────────────────
// The esc helper is private, but its effect is visible in the html field of
// the sendMail call when special characters appear in errorMessage.

describe('HTML escaping in sendError', () => {
  beforeEach(() => {
    mockSendMail.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('escapes & in the error message inside the HTML body', async () => {
    await sendError(BASE_SETTINGS, 'pass', 'foo & bar')
    const call = mockSendMail.mock.calls[0][0]
    expect(call.html).toContain('foo &amp; bar')
    expect(call.html).not.toContain('foo & bar')
  })

  it('escapes < and > in the error message', async () => {
    await sendError(BASE_SETTINGS, 'pass', '<script>')
    const call = mockSendMail.mock.calls[0][0]
    expect(call.html).toContain('&lt;script&gt;')
  })

  it('escapes double-quotes in the error message', async () => {
    await sendError(BASE_SETTINGS, 'pass', 'say "hello"')
    const call = mockSendMail.mock.calls[0][0]
    expect(call.html).toContain('say &quot;hello&quot;')
  })
})

// ─── MAIL_STRINGS / language selection ───────────────────────────────────────

describe('sendError language selection', () => {
  beforeEach(() => {
    mockSendMail.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('uses English strings when language is "en"', async () => {
    await sendError(BASE_SETTINGS, 'pass', 'audio device not found')
    const call = mockSendMail.mock.calls[0][0]
    expect(call.subject).toContain('Recording error')
    expect(call.text).toContain('Hello Alice')
  })

  it('uses Norwegian strings when language is "no"', async () => {
    const settings = { ...BASE_SETTINGS, language: 'no' }
    await sendError(settings as unknown as Settings, 'pass', 'feil')
    const call = mockSendMail.mock.calls[0][0]
    expect(call.subject).toContain('Opptaksfeil')
    expect(call.text).toContain('Hei Alice')
  })

  it('uses German strings when language is "de"', async () => {
    const settings = { ...BASE_SETTINGS, language: 'de' }
    await sendError(settings as unknown as Settings, 'pass', 'Fehler')
    const call = mockSendMail.mock.calls[0][0]
    expect(call.subject).toContain('Aufnahmefehler')
  })

  it('falls back to Norwegian when language is unknown', async () => {
    const settings = { ...BASE_SETTINGS, language: 'xx' as any }
    await sendError(settings as unknown as Settings, 'pass', 'err')
    const call = mockSendMail.mock.calls[0][0]
    expect(call.subject).toContain('Opptaksfeil')
  })

  it('uses church name in subject', async () => {
    await sendError(BASE_SETTINGS, 'pass', 'err')
    const call = mockSendMail.mock.calls[0][0]
    expect(call.subject).toContain('Test Church')
  })
})

// ─── sendError — silent on send failure ──────────────────────────────────────

describe('sendError error handling', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('does not throw when sendMail rejects', async () => {
    mockSendMail.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(
      sendError(BASE_SETTINGS, 'pass', 'audio error')
    ).resolves.toBeUndefined()
  })
})

// ─── sendError — skips send when config is incomplete ────────────────────────

describe('sendError with missing config', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('returns without calling sendMail when emailAddress is missing', async () => {
    const settings = { ...BASE_SETTINGS, emailAddress: undefined } as unknown as Settings
    await sendError(settings, 'pass', 'err')
    expect(mockSendMail).not.toHaveBeenCalled()
  })

  it('returns without calling sendMail when emailSmtp is missing', async () => {
    const settings = { ...BASE_SETTINGS, emailSmtp: undefined } as unknown as Settings
    await sendError(settings, 'pass', 'err')
    expect(mockSendMail).not.toHaveBeenCalled()
  })
})

// ─── sendTest ─────────────────────────────────────────────────────────────────

describe('sendTest', () => {
  beforeEach(() => {
    mockSendMail.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('sends a mail with the correct English subject', async () => {
    await sendTest(BASE_SETTINGS, 'pass')
    const call = mockSendMail.mock.calls[0][0]
    expect(call.subject).toContain('email works')
  })

  it('sends a mail with the correct Norwegian subject', async () => {
    const settings = { ...BASE_SETTINGS, language: 'no' }
    await sendTest(settings as unknown as Settings, 'pass')
    const call = mockSendMail.mock.calls[0][0]
    expect(call.subject).toContain('e-post fungerer')
  })

  it('sends to the configured emailAddress', async () => {
    await sendTest(BASE_SETTINGS, 'pass')
    const call = mockSendMail.mock.calls[0][0]
    expect(call.to).toBe('test@example.com')
  })

  it('throws no_config when emailAddress is missing', async () => {
    const settings = { ...BASE_SETTINGS, emailAddress: undefined } as unknown as Settings
    await expect(sendTest(settings, 'pass')).rejects.toThrow('no_config')
  })

  it('throws no_config when emailSmtp is missing', async () => {
    const settings = { ...BASE_SETTINGS, emailSmtp: undefined } as unknown as Settings
    await expect(sendTest(settings, 'pass')).rejects.toThrow('no_config')
  })

  it('creates a transporter with the correct SMTP host', async () => {
    await sendTest(BASE_SETTINGS, 'pass')
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com' })
    )
  })

  it('sets secure:true when port is 465', async () => {
    const settings = { ...BASE_SETTINGS, emailSmtpPort: 465 }
    await sendTest(settings as unknown as Settings, 'pass')
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: true })
    )
  })

  it('sets secure:false for non-465 ports', async () => {
    await sendTest(BASE_SETTINGS, 'pass')   // port 587
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false })
    )
  })
})

// ─── TEST_STRINGS coverage ────────────────────────────────────────────────────

describe('sendTest language strings', () => {
  beforeEach(() => {
    mockSendMail.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it.each([
    ['de', 'E-Mail funktioniert'],
    ['sv', 'e-post fungerar'],
    ['da', 'e-mail virker'],
    ['pl', 'e-mail działa'],
    ['fr', 'e-mail fonctionne'],
  ])('language %s sends correct subject', async (lang, fragment) => {
    const settings = { ...BASE_SETTINGS, language: lang as any }
    await sendTest(settings as unknown as Settings, 'pass')
    const call = mockSendMail.mock.calls[0][0]
    expect(call.subject).toContain(fragment)
  })
})
