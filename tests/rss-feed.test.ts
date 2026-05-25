import { buildPodcastXml, type PodcastChannel, type PodcastEpisode } from '../src/main/publish/rss-feed'

const baseChannel: PodcastChannel = {
  title:       'Eksempel kirke',
  description: 'Gudstjenester fra Eksempel kirke',
  author:      'Eksempel kirke',
  language:    'no',
  category:    'Religion & Spirituality',
  explicit:    false,
}

function makeEpisode(overrides: Partial<PodcastEpisode> = {}): PodcastEpisode {
  return {
    title:      'Gudstjeneste 17. mai',
    pubDate:    new Date('2026-05-17T11:00:00Z'),
    guid:       'sundayrec-2026-05-17',
    audioUrl:   'https://example.com/audio.mp3',
    audioBytes: 50_000_000,
    ...overrides,
  }
}

describe('buildPodcastXml — channel', () => {
  it('starts with XML declaration and RSS root', () => {
    const xml = buildPodcastXml(baseChannel, [])
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<rss version="2.0"')
    expect(xml).toContain('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"')
    expect(xml).toContain('xmlns:atom="http://www.w3.org/2005/Atom"')
    expect(xml.trim().endsWith('</rss>')).toBe(true)
  })

  it('includes all required channel-level metadata', () => {
    const xml = buildPodcastXml(baseChannel, [])
    expect(xml).toContain('<title>Eksempel kirke</title>')
    expect(xml).toContain('<description>Gudstjenester fra Eksempel kirke</description>')
    expect(xml).toContain('<language>no</language>')
    expect(xml).toContain('<itunes:author>Eksempel kirke</itunes:author>')
    expect(xml).toContain('<itunes:explicit>false</itunes:explicit>')
    expect(xml).toContain('<itunes:category text="Religion &amp; Spirituality"/>')
  })

  it('escapes XML special characters in titles and descriptions', () => {
    const xml = buildPodcastXml({
      ...baseChannel,
      title:       'A & B <Cool> "Show"',
      description: 'It\'s great & fun',
    }, [])
    expect(xml).toContain('<title>A &amp; B &lt;Cool&gt; &quot;Show&quot;</title>')
    expect(xml).toContain('<description>It&apos;s great &amp; fun</description>')
  })

  it('handles Norwegian characters in titles', () => {
    const xml = buildPodcastXml({ ...baseChannel, title: 'Søndagsgudstjeneste på fjellet' }, [])
    expect(xml).toContain('<title>Søndagsgudstjeneste på fjellet</title>')
  })

  it('omits optional fields when not provided', () => {
    const xml = buildPodcastXml(baseChannel, [])
    expect(xml).not.toContain('<link>')
    expect(xml).not.toContain('<itunes:image')
    expect(xml).not.toContain('<itunes:owner>')
    expect(xml).not.toContain('<atom:link')
  })

  it('includes optional fields when provided', () => {
    const xml = buildPodcastXml({
      ...baseChannel,
      link:     'https://eksempelkirke.no',
      imageUrl: 'https://eksempelkirke.no/cover.jpg',
      email:    'kontakt@eksempelkirke.no',
      feedUrl:  'https://eksempelkirke.no/podcast.xml',
    }, [])
    expect(xml).toContain('<link>https://eksempelkirke.no</link>')
    expect(xml).toContain('<itunes:image href="https://eksempelkirke.no/cover.jpg"/>')
    expect(xml).toContain('<itunes:owner>')
    expect(xml).toContain('<itunes:email>kontakt@eksempelkirke.no</itunes:email>')
    expect(xml).toContain('<atom:link href="https://eksempelkirke.no/podcast.xml" rel="self"')
  })

  it('emits explicit=true when channel.explicit is true', () => {
    const xml = buildPodcastXml({ ...baseChannel, explicit: true }, [])
    expect(xml).toContain('<itunes:explicit>true</itunes:explicit>')
  })

  it('includes lastBuildDate and generator', () => {
    const xml = buildPodcastXml(baseChannel, [])
    expect(xml).toContain('<lastBuildDate>')
    expect(xml).toContain('<generator>SundayRec</generator>')
  })
})

describe('buildPodcastXml — episodes', () => {
  it('produces no <item> elements when episode list is empty', () => {
    const xml = buildPodcastXml(baseChannel, [])
    expect(xml).not.toContain('<item>')
  })

  it('emits one <item> per episode', () => {
    const xml = buildPodcastXml(baseChannel, [
      makeEpisode({ guid: 'a', title: 'A' }),
      makeEpisode({ guid: 'b', title: 'B' }),
      makeEpisode({ guid: 'c', title: 'C' }),
    ])
    expect((xml.match(/<item>/g) ?? []).length).toBe(3)
    expect((xml.match(/<\/item>/g) ?? []).length).toBe(3)
  })

  it('includes title, pubDate, guid, and enclosure for each episode', () => {
    const xml = buildPodcastXml(baseChannel, [makeEpisode()])
    expect(xml).toContain('<title>Gudstjeneste 17. mai</title>')
    expect(xml).toContain('<pubDate>Sun, 17 May 2026 11:00:00 GMT</pubDate>')
    expect(xml).toContain('<guid isPermaLink="false">sundayrec-2026-05-17</guid>')
    expect(xml).toContain('<enclosure url="https://example.com/audio.mp3" length="50000000" type="audio/mpeg"/>')
  })

  it('preserves episode order (no auto-sort)', () => {
    const xml = buildPodcastXml(baseChannel, [
      makeEpisode({ guid: 'first',  title: 'First',  pubDate: new Date('2026-01-01T10:00:00Z') }),
      makeEpisode({ guid: 'second', title: 'Second', pubDate: new Date('2026-05-01T10:00:00Z') }),
    ])
    const firstIdx  = xml.indexOf('First')
    const secondIdx = xml.indexOf('Second')
    expect(firstIdx).toBeLessThan(secondIdx)
  })

  it('infers MIME type from filename extension', () => {
    const cases: Array<[string, string]> = [
      ['https://x/a.mp3',  'audio/mpeg'],
      ['https://x/a.wav',  'audio/wav'],
      ['https://x/a.flac', 'audio/flac'],
      ['https://x/a.m4a',  'audio/aac'],
      ['https://x/a.ogg',  'audio/ogg'],
      ['https://x/a.opus', 'audio/ogg'],
      ['https://x/a.mp4',  'video/mp4'],
      ['https://x/a.mov',  'video/quicktime'],
    ]
    for (const [url, mime] of cases) {
      const xml = buildPodcastXml(baseChannel, [makeEpisode({ audioUrl: url })])
      expect(xml).toContain(`type="${mime}"`)
    }
  })

  it('falls back to audio/mpeg for unknown extensions', () => {
    const xml = buildPodcastXml(baseChannel, [makeEpisode({ audioUrl: 'https://x/a.xyz' })])
    expect(xml).toContain('type="audio/mpeg"')
  })

  it('strips query strings before deriving MIME from extension', () => {
    const xml = buildPodcastXml(baseChannel, [makeEpisode({ audioUrl: 'https://x/a.mp3?token=abc' })])
    expect(xml).toContain('type="audio/mpeg"')
  })

  it('honors explicit mimeType override', () => {
    const xml = buildPodcastXml(baseChannel, [makeEpisode({ audioUrl: 'https://x/a', mimeType: 'audio/aac' })])
    expect(xml).toContain('type="audio/aac"')
  })

  it('emits itunes:duration as HH:MM:SS when duration provided', () => {
    const xml = buildPodcastXml(baseChannel, [makeEpisode({ durationSec: 3725 })])  // 1h 2m 5s
    expect(xml).toContain('<itunes:duration>01:02:05</itunes:duration>')
  })

  it('omits itunes:duration when not provided', () => {
    const xml = buildPodcastXml(baseChannel, [makeEpisode()])
    expect(xml).not.toContain('<itunes:duration>')
  })

  it('omits itunes:duration when duration is zero', () => {
    const xml = buildPodcastXml(baseChannel, [makeEpisode({ durationSec: 0 })])
    expect(xml).not.toContain('<itunes:duration>')
  })

  it('floors negative audioBytes to 0', () => {
    const xml = buildPodcastXml(baseChannel, [makeEpisode({ audioBytes: -1 })])
    expect(xml).toContain('length="0"')
  })

  it('escapes special characters in episode URLs', () => {
    const xml = buildPodcastXml(baseChannel, [makeEpisode({ audioUrl: 'https://x/a?b=1&c=2' })])
    expect(xml).toContain('https://x/a?b=1&amp;c=2')
  })

  it('escapes special characters in episode titles', () => {
    const xml = buildPodcastXml(baseChannel, [makeEpisode({ title: 'Bryllup & dåp' })])
    expect(xml).toContain('<title>Bryllup &amp; dåp</title>')
  })
})

describe('buildPodcastXml — output validity', () => {
  it('produces UTF-8 declaration', () => {
    const xml = buildPodcastXml(baseChannel, [])
    expect(xml).toMatch(/encoding="UTF-8"/)
  })

  it('every opened tag has a matching close (or is self-closing)', () => {
    // Spot-check: well-formedness heuristic for common tags
    const xml = buildPodcastXml(baseChannel, [makeEpisode(), makeEpisode({ guid: 'b' })])
    for (const tag of ['rss', 'channel', 'item', 'title', 'description', 'pubDate', 'guid']) {
      const open  = (xml.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length
      const close = (xml.match(new RegExp(`</${tag}>`,    'g')) ?? []).length
      expect(open).toBe(close)
    }
  })

  it('handles many episodes (50) without crashing', () => {
    const eps: PodcastEpisode[] = []
    for (let i = 0; i < 50; i++) {
      eps.push(makeEpisode({ guid: `ep-${i}`, title: `Episode ${i}` }))
    }
    const xml = buildPodcastXml(baseChannel, eps)
    expect((xml.match(/<item>/g) ?? []).length).toBe(50)
  })
})
