/**
 * The app's own voice in a transcript — lines it writes about itself rather
 * than anything the model or the user said. The phone page carries the same
 * words (it cannot import this); a unit test holds the two together.
 */

/** Written when the pause button stops a run. */
export const PAUSE_LABEL = 'Okay, Take a break mate!'

/** Written in place of the continuation prompt when a paused run resumes. */
export const RESUME_LABEL = 'ah sh**, here we go again'

/** Written under an instruction sent while a run was already working. */
export const FOLLOW_UP_LABEL = 'wait a minutes, bi***'

/** The instruction a resume actually sends; the phone sends the same words.
 * Both sides show RESUME_LABEL in its place, never this paragraph. */
export const CONTINUE_PROMPT =
  'Lanjutkan pekerjaan yang terhenti persis dari titik terakhir. Jangan ulangi langkah yang sudah selesai.'
