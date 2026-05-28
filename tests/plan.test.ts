/**
 * Tests for src/main/integrations/plan.ts — pure helpers only.
 * fetchUpcomingServices / updateServiceRecording make real HTTP calls; not tested here.
 */

import {
  serviceToMetadata,
  serviceToSchedule,
  type PlanService,
} from '../src/main/integrations/plan'

const service: PlanService = {
  id: 'svc-1',
  name: 'Gudstjeneste 1. juni',
  starts_at_utc: '2026-06-01T09:00:00.000Z',
  state: 'published',
  items: [
    { id: 'i-1', kind: 'song', label: 'Amazing Grace' },
    { id: 'i-2', kind: 'sermon', label: 'Preken', assignment: { speaker: 'Ola Nordmann' } },
    { id: 'i-3', kind: 'song', label: 'Sluttmelodi' },
  ],
}

describe('serviceToMetadata', () => {
  it('uses service.name as title', () => {
    expect(serviceToMetadata(service).title).toBe('Gudstjeneste 1. juni')
  })

  it('extracts speaker from the sermon item assignment', () => {
    expect(serviceToMetadata(service).speaker).toBe('Ola Nordmann')
  })

  it('returns empty speaker when no sermon item exists', () => {
    const noSermon: PlanService = { ...service, items: [{ id: 'i-1', kind: 'song', label: 'Song' }] }
    expect(serviceToMetadata(noSermon).speaker).toBe('')
  })

  it('falls back to Gudstjeneste when name is empty', () => {
    const unnamed: PlanService = { ...service, name: '' }
    expect(serviceToMetadata(unnamed).title).toBe('Gudstjeneste')
  })
})

describe('serviceToSchedule', () => {
  it('parses UTC ISO datetime into local date+time strings', () => {
    const sched = serviceToSchedule(service)
    expect(sched).not.toBeNull()
    expect(sched!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(sched!.startTime).toMatch(/^\d{2}:\d{2}$/)
    expect(sched!.stopTime).toMatch(/^\d{2}:\d{2}$/)
    expect(sched!.note).toBe('Gudstjeneste 1. juni')
  })

  it('sets stopTime 2 hours after startTime', () => {
    // Parse in local tz so the time arithmetic is consistent
    const sched = serviceToSchedule(service)!
    const [sh, sm] = sched.startTime.split(':').map(Number)
    const [eh, em] = sched.stopTime.split(':').map(Number)
    const diffMin = (eh * 60 + em) - (sh * 60 + sm)
    expect(diffMin).toBe(120)
  })

  it('returns null for an invalid date', () => {
    const bad: PlanService = { ...service, starts_at_utc: 'not-a-date' }
    expect(serviceToSchedule(bad)).toBeNull()
  })
})
