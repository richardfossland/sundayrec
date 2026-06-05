// Pure time formatters for the editor timeline / cut list / ruler.

export function formatTime(s: number): string {
  const h   = Math.floor(s / 3600)
  const m   = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`
}

export function formatDuration(s: number): string {
  if (s < 1)   return `${(s * 1000).toFixed(0)}ms`
  if (s < 60)  return `${s.toFixed(1)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
  return `${Math.floor(s / 3600)}t ${Math.floor((s % 3600) / 60)}m`
}
