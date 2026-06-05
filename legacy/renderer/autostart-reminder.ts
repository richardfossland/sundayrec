import { settings } from './state'
import { t } from './i18n'

/**
 * Called right after the user schedules an automatic recording (a weekly slot or a
 * special day). If the app isn't set to launch at login it won't be RUNNING at the
 * scheduled time — so a planned recording silently never fires after a reboot or a
 * quit. Remind the user and offer to turn it on in one click.
 *
 * `saveSettings` registers the OS login item (via the shim's syncLaunchAtLogin), so
 * flipping the flag + saving is all that's needed.
 */
export async function remindAutostartIfNeeded(): Promise<void> {
  if (settings.launchAtLogin) return // already armed — nothing to nag about

  const ok = confirm(
    t(
      'schedule.autostartReminder',
      'Opptaket er lagt til.\n\n' +
        'Men «Start automatisk med Windows/Mac» er AV — da starter ikke planlagte ' +
        'opptak hvis maskinen har vært slått av eller programmet er lukket.\n\n' +
        'Vil du slå på automatisk start nå, så programmet alltid er klart?',
    ),
  )
  if (!ok) return

  settings.launchAtLogin = true
  await window.api.saveSettings(settings)
}
