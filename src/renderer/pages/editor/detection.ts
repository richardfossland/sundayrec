import { E } from './state'

// Segment detection / analyze panel. (Full detection logic lands here in a
// later phase; for now just the display predicate the waveform renderer needs.)

export function shouldShowSegment(type: string): boolean {
  if (type === 'sermon') return true
  if (type === 'speech') return E.showSpeechSegments
  if (type === 'music')  return E.showMusicSegments
  if (type === 'silence') return E.showSilenceSegments
  // mixed / unknown → render only if speech is on (closest match)
  return E.showSpeechSegments
}
