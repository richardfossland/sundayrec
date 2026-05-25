/**
 * Podcast publishing orchestration.
 *
 * Flow:
 *   1. Recording finishes  → recorder.ts adds history entry
 *   2. Auto-upload kicks in → cloud/index.ts uploads audio to user's selected service
 *   3. After successful upload → this module runs:
 *        a. Generates a public share URL for the audio file
 *        b. Stores that URL in history entry's cloudUrls map
 *        c. Rebuilds the RSS XML from all entries with share URLs
 *        d. Writes podcast.xml locally, uploads it to the cloud, and
 *           generates a share URL for the feed itself
 *        e. Caches the feed URL on the podcast settings so the UI can
 *           show "submit this URL to Spotify/Apple"
 *
 * Errors in any step are logged but never thrown — podcast publishing
 * is best-effort and must never break a successful recording upload.
 */

import fs   from 'fs'
import path from 'path'
import * as store         from '../store'
import * as logger        from '../logger'
import * as googleDrive   from '../cloud/google-drive'
import * as tokenStore    from '../cloud/token-store'
import { buildPodcastXml, type PodcastChannel, type PodcastEpisode } from './rss-feed'
import type { CloudServiceId, PodcastSettings } from '../../types'

const RSS_FILENAME = 'podcast.xml'

/**
 * Called after a successful cloud upload. Generates a share URL for the
 * uploaded audio file, stores it on the history entry, then regenerates +
 * uploads the podcast RSS feed.
 *
 * Only acts when:
 *   - Podcast publishing is enabled in settings
 *   - The service that just uploaded matches the configured podcast.service
 *
 * `accessToken` getter is passed in so this module doesn't have to take a
 * dependency on the cloud auth flow.
 */
export async function onCloudUploadComplete(
  service:        CloudServiceId,
  filePath:       string,
  fileId:         string,
  entryTimestamp: number | undefined,
  getAccessToken: (service: CloudServiceId) => Promise<string>,
): Promise<void> {
  const podcast = store.get('podcast') as PodcastSettings | undefined
  if (!podcast?.enabled) return
  if (podcast.service !== service) return  // only publish from the configured service

  try {
    // 1. Make the audio file publicly readable and capture the URL.
    const token    = await getAccessToken(service)
    const shareUrl = await getShareUrl(service, token, fileId)
    if (!shareUrl) {
      logger.warn('publish', 'share_url_failed', { service, fileId })
      return
    }
    if (entryTimestamp !== undefined) {
      store.setCloudUrl(entryTimestamp, service, shareUrl)
    }

    // 2. Rebuild + upload the feed.
    await regeneratePodcastFeed(service, getAccessToken)
  } catch (err) {
    logger.warn('publish', 'on_upload_failed', { error: (err as Error).message })
  }
}

/**
 * Build the RSS feed from current history and upload it to the configured
 * cloud service. Safe to call manually (e.g. from a "Regenerate feed now"
 * button) — it does NOT re-share already-shared audio files.
 */
export async function regeneratePodcastFeed(
  service:        CloudServiceId,
  getAccessToken: (service: CloudServiceId) => Promise<string>,
): Promise<{ ok: boolean; feedUrl?: string; episodeCount: number; error?: string }> {
  const podcast = store.get('podcast') as PodcastSettings | undefined
  if (!podcast?.enabled) return { ok: false, episodeCount: 0, error: 'podcast_disabled' }

  // Only include history entries that:
  //  - have been uploaded to the configured service
  //  - have a public URL captured
  //  - were successful recordings (status === 'ok')
  const history = store.getHistory()
  const candidates = history.filter(h =>
    h.status === 'ok' &&
    h.cloudUploaded?.includes(service) &&
    h.cloudUrls?.[service] &&
    h.timestamp != null,
  )

  // Newest first — most podcast apps show episodes in this order
  candidates.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))

  const episodes: PodcastEpisode[] = candidates.map(h => ({
    title:       h.filename.replace(/\.[^.]+$/, ''),       // strip extension
    description: h.note,
    pubDate:     new Date(h.timestamp!),
    guid:        `sundayrec-${h.timestamp}`,
    audioUrl:    h.cloudUrls![service],
    audioBytes:  h.fileSizeBytes ?? 0,
    durationSec: h.durationSec,
  }))

  const channel: PodcastChannel = {
    title:       podcast.title       || 'SundayRec',
    description: podcast.description || 'Lydopptak fra SundayRec',
    author:      podcast.author      || podcast.title || 'SundayRec',
    language:    podcast.language    || 'no',
    category:    podcast.category    || 'Religion & Spirituality',
    explicit:    podcast.explicit    ?? false,
    link:        podcast.link,
    imageUrl:    podcast.imageUrl,
    email:       podcast.email,
    feedUrl:     podcast.feedUrl,
  }

  const xml = buildPodcastXml(channel, episodes)

  // Write locally next to the user's saveFolder so they always have a copy.
  const saveFolder = store.get('saveFolder')
  if (!saveFolder) return { ok: false, episodeCount: episodes.length, error: 'no_save_folder' }

  const localPath = path.join(saveFolder, RSS_FILENAME)
  try {
    fs.writeFileSync(localPath, xml, 'utf-8')
  } catch (err) {
    logger.error('publish', 'write_local_failed', { error: (err as Error).message })
    return { ok: false, episodeCount: episodes.length, error: 'write_failed' }
  }

  // Upload to the cloud + make publicly readable + cache the feed URL.
  try {
    const tok = tokenStore.getToken(service)
    if (!tok) return { ok: false, episodeCount: episodes.length, error: 'not_connected' }

    const token   = await getAccessToken(service)
    const feedId  = await uploadFeedFile(service, token, localPath, tok.folderId)
    if (!feedId) return { ok: false, episodeCount: episodes.length, error: 'upload_failed' }

    const feedUrl = await getShareUrl(service, token, feedId)
    if (feedUrl && feedUrl !== podcast.feedUrl) {
      store.set('podcast', { ...podcast, feedUrl } as never)
    }
    logger.info('publish', 'feed_published', { service, episodes: episodes.length, feedUrl })
    return { ok: true, feedUrl: feedUrl ?? undefined, episodeCount: episodes.length }
  } catch (err) {
    logger.error('publish', 'feed_upload_failed', { error: (err as Error).message })
    return { ok: false, episodeCount: episodes.length, error: (err as Error).message }
  }
}

async function getShareUrl(service: CloudServiceId, token: string, fileId: string): Promise<string | null> {
  if (service === 'google-drive') return googleDrive.createPublicShareUrl(token, fileId)
  // Dropbox and OneDrive share-link helpers come in a later phase.
  return null
}

async function uploadFeedFile(service: CloudServiceId, token: string, filePath: string, folderId?: string): Promise<string | null> {
  if (service === 'google-drive') {
    // We re-use the existing uploadFile machinery so retries + chunking work
    // identically to audio uploads. Feed files are tiny so this is overkill,
    // but consistency > optimization.
    return googleDrive.uploadFile(token, filePath, folderId)
  }
  return null
}
