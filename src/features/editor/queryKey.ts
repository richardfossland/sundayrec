/** TanStack Query keys for the editor panel. The recordings list is shared with
 *  the history panel's source; the per-file load/peaks/segments are keyed by the
 *  selected path so switching recordings refetches cleanly. */
export const EDITOR_RECORDINGS_KEY = ["editor", "recordings"] as const;

/** Per-recording load probe (duration/streams), keyed by file path. */
export const editorLoadKey = (path: string) =>
  ["editor", "load", path] as const;
