/**
 * The app's own voice in a transcript — lines it writes about itself rather
 * than anything the model or the user said. The phone page carries the same
 * words (it cannot import this); a unit test holds the two together.
 */

/** Written when the pause button stops a run. */
export { PAUSE_LABEL } from '@shared/ipc'

/** Written in place of the continuation prompt when a paused run resumes. */
export { RESUME_LABEL } from '@shared/ipc'

/** Written under an instruction sent while a run was already working. */
export { FOLLOW_UP_LABEL } from '@shared/ipc'

/** The instruction a resume actually sends; the phone sends the same words.
 * Both sides show RESUME_LABEL in its place, never this paragraph. It lives
 * in the shared contract because the main process tells it from a typed one. */
export { CONTINUE_PROMPT } from '@shared/ipc'
