/**
 * Cloud-extras IPC — the cloud-adjacent handlers that didn't fit in
 * ipc/cloud.ts: YouTube video upload (with safe metadata sanitisation),
 * manual podcast feed regeneration (with in-flight coalescing), and a
 * simple is-this-service-configured probe used by the renderer to grey
 * out buttons before the OAuth flow.
 *
 * podcast-regenerate coalesces concurrent calls per service so two
 * quick "Publiser nå"-clicks don't race each other writing podcast.xml.
 */

import { ipcMain } from 'electron'
import type { IpcContext } from './types'

export interface CloudExtrasIpcContext extends IpcContext {
  isAllowedMediaPath: (filePath: string) => boolean
}

export function registerCloudExtrasIpc(ctx: CloudExtrasIpcContext): void {
  ipcMain.handle('youtube-upload', async (_, filePath: string, metadata: unknown) => {
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'invalid_path' }
    if (!ctx.isAllowedMediaPath(filePath))         return { ok: false, error: 'invalid_path' }
    const yt = await import('../cloud/youtube')
    const md = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>
    const safeMeta = {
      title:         typeof md.title === 'string' ? md.title : 'SundayRec Recording',
      description:   typeof md.description === 'string' ? md.description : '',
      tags:          Array.isArray(md.tags) ? (md.tags as unknown[]).filter(s => typeof s === 'string') as string[] : undefined,
      categoryId:    typeof md.categoryId === 'string' ? md.categoryId : undefined,
      privacyStatus: md.privacyStatus === 'public' || md.privacyStatus === 'unlisted' ? md.privacyStatus : 'private' as const,
    }
    const onProgress = (uploadedBytes: number, totalBytes: number) => {
      ctx.mainWindow?.webContents.send('youtube-upload-progress', { uploadedBytes, totalBytes })
    }
    return yt.uploadVideo(filePath, safeMeta, onProgress)
  })

  // Coalesce concurrent regenerate requests per service. Two quick clicks
  // (or a publish-after-export running while auto-publish from upload-complete
  // is mid-flight) otherwise race to write podcast.xml and upload it.
  const podcastRegenInflight = new Map<string, Promise<unknown>>()
  ipcMain.handle('podcast-regenerate', async (_, service: string) => {
    if (typeof service !== 'string' || !service) {
      return { ok: false, episodeCount: 0, error: 'invalid_service' }
    }
    const existing = podcastRegenInflight.get(service)
    if (existing) return existing
    const cloud = await import('../cloud')
    const promise = cloud.regeneratePodcastFeedManual(service as import('../../types').CloudServiceId)
      .finally(() => podcastRegenInflight.delete(service))
    podcastRegenInflight.set(service, promise)
    return promise
  })

  ipcMain.handle('cloud-is-configured', async (_, service: string) => {
    const cloud = await import('../cloud')
    return cloud.isServiceConfigured(service as import('../../types').CloudServiceId)
  })
}
