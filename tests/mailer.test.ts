import nodemailer from 'nodemailer'
import { sendTest, sendError } from '../src/main/mailer'
import type { Settings } from '../src/types'

jest.mock('nodemailer', () => ({
  createTransport: jest.fn()
}))

const mockCreateTransport = nodemailer.createTransport as jest.Mock

const BASE_SETTINGS: Partial<Settings> = {
  emailAddress:      'recipient@example.com',
  emailSmtp:         'smtp.example.com',
  emailSmtpPort:     587,
  emailSmtpUser:     'sender@example.com',
  language:          'en',
  churchName:        'Grace Church',
  responsiblePerson: 'John Doe',
}

let mockSendMail: jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-id' })
  mockCreateTransport.mockReturnValue({ sendMail: mockSendMail })
})

// ─── sendTest ────────────────────────────────────────────────────────────────

describe('sendTest', () => {
  it('throws no_config when emailAddress is missing', async () => {
    await expect(sendTest({ ...BASE_SETTINGS, emailAddress: '' } as Settings, 'pw'))
      .rejects.toThrow('no_config')
  })

  it('throws no_config when emailSmtp is missing', async () => {
    await expect(sendTest({ ...BASE_SETTINGS, emailSmtp: '' } as Settings, 'pw'))
      .rejects.toThrow('no_config')
  })

  it('creates a transporter with the configured host and port', async () => {
    await sendTest(BASE_SETTINGS as Settings, 'secret')
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
      })
    )
  })

  it('enables secure when port is 465', async () => {
    await sendTest({ ...BASE_SETTINGS, emailSmtpPort: 465 } as Settings, 'pw')
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true })
    )
  })

  it('passes SMTP auth credentials', async () => {
    await sendTest(BASE_SETTINGS as Settings, 'mypassword')
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { user: 'sender@example.com', pass: 'mypassword' },
      })
    )
  })

  it('sends to the configured emailAddress', async () => {
    await sendTest(BASE_SETTINGS as Settings, 'pw')
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'recipient@example.com' })
    )
  })

  it('uses English subject when language is en', async () => {
    await sendTest(BASE_SETTINGS as Settings, 'pw')
    const { subject } = mockSendMail.mock.calls[0][0]
    expect(subject).toContain('SundayRec')
    expect(subject).toContain('email works')
  })

  it('uses Norwegian subject when language is no', async () => {
    await sendTest({ ...BASE_SETTINGS, language: 'no' } as Settings, 'pw')
    const { subject } = mockSendMail.mock.calls[0][0]
    expect(subject).toContain('e-post fungerer')
  })

  it('falls back to Norwegian when language is unknown', async () => {
    await sendTest({ ...BASE_SETTINGS, language: 'zz' as any } as Settings, 'pw')
    const { subject } = mockSendMail.mock.calls[0][0]
    expect(subject).toContain('e-post fungerer')
  })

  it('omits auth when emailSmtpUser is empty', async () => {
    await sendTest({ ...BASE_SETTINGS, emailSmtpUser: '' } as Settings, 'pw')
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: undefined })
    )
  })
})

// ─── sendError ───────────────────────────────────────────────────────────────

describe('sendError', () => {
  it('returns silently when emailAddress is not configured', async () => {
    await sendError({ ...BASE_SETTINGS, emailAddress: '' } as Settings, 'pw', 'Device not found')
    expect(mockSendMail).not.toHaveBeenCalled()
  })

  it('returns silently when emailSmtp is not configured', async () => {
    await sendError({ ...BASE_SETTINGS, emailSmtp: '' } as Settings, 'pw', 'Device not found')
    expect(mockSendMail).not.toHaveBeenCalled()
  })

  it('sends an email when config is present', async () => {
    await sendError(BASE_SETTINGS as Settings, 'pw', 'Device not found')
    expect(mockSendMail).toHaveBeenCalledTimes(1)
  })

  it('includes the error message in the plain-text body', async () => {
    await sendError(BASE_SETTINGS as Settings, 'pw', 'Mixer disconnected')
    const { text } = mockSendMail.mock.calls[0][0]
    expect(text).toContain('Mixer disconnected')
  })

  it('includes the error message in the HTML body', async () => {
    await sendError(BASE_SETTINGS as Settings, 'pw', 'Mixer disconnected')
    const { html } = mockSendMail.mock.calls[0][0]
    expect(html).toContain('Mixer disconnected')
  })

  it('HTML-escapes < > & " \' in the error message', async () => {
    await sendError(BASE_SETTINGS as Settings, 'pw', '<script>alert("xss")&test\'end</script>')
    const { html } = mockSendMail.mock.calls[0][0]
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;xss&quot;')
    expect(html).toContain('&amp;test')
    expect(html).toContain('&#39;end')
  })

  it('uses the church name in the subject', async () => {
    await sendError(BASE_SETTINGS as Settings, 'pw', 'err')
    const { subject } = mockSendMail.mock.calls[0][0]
    expect(subject).toContain('Grace Church')
  })

  it('uses English subject when language is en', async () => {
    await sendError(BASE_SETTINGS as Settings, 'pw', 'err')
    const { subject } = mockSendMail.mock.calls[0][0]
    expect(subject).toContain('Recording error')
  })

  it('uses German subject when language is de', async () => {
    await sendError({ ...BASE_SETTINGS, language: 'de' } as Settings, 'pw', 'err')
    const { subject } = mockSendMail.mock.calls[0][0]
    expect(subject).toContain('Aufnahmefehler')
  })

  it('includes the responsible person greeting in the body', async () => {
    await sendError(BASE_SETTINGS as Settings, 'pw', 'err')
    const { text } = mockSendMail.mock.calls[0][0]
    expect(text).toContain('John Doe')
  })

  it('does not throw when sendMail rejects — error is swallowed', async () => {
    mockSendMail.mockRejectedValue(new Error('SMTP timeout'))
    await expect(
      sendError(BASE_SETTINGS as Settings, 'pw', 'err')
    ).resolves.toBeUndefined()
  })
})
