import path from 'node:path'
import type { AttachmentInfo, AttachmentRef } from '@shared/ipc'
import type { ContentBlock } from '../providers/types'
import { getStatus, sessionFileRoot, sessionMode } from '../runtime'
import {
  AttachmentError,
  placeInWorkspace,
  UPLOADS_DIR,
  prepareAttachment,
  stageAttachmentData,
  toContentBlocks,
  toRef
} from './index'

/**
 * Files staged for a prompt that has not been sent yet, from the desktop or
 * the phone. An entry lives until its run starts, or until the composer drops
 * it — nothing here survives a restart, and none of it is a copy of the file.
 */
const staged = new Map<string, AttachmentInfo>()

async function keep(paths: string[]): Promise<AttachmentInfo[]> {
  const root = getStatus().workspaceRoot
  // Atomic: one unreadable file would otherwise register a half batch the
  // user cannot see. Every failure is named so the bad file is findable.
  const settled = await Promise.allSettled(paths.map((file) => prepareAttachment(file, root)))
  const failures = settled
    .filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
    .map((entry) => (entry.reason as Error).message)

  const prepared = settled
    .filter((entry): entry is PromiseFulfilledResult<AttachmentInfo> => entry.status === 'fulfilled')
    .map((entry) => entry.value)
  if (failures.length > 0) throw new AttachmentError(failures.join('\n'))
  for (const item of prepared) staged.set(item.id, item)
  return prepared
}

export function registerAttachments(paths: string[]): Promise<AttachmentInfo[]> {
  return keep(paths)
}

/** For bytes with no file of their own: a pasted screenshot, a phone upload. */
export async function registerAttachmentData(
  name: string,
  data: Buffer
): Promise<AttachmentInfo[]> {
  return keep([await stageAttachmentData(name, data)])
}

export function releaseAttachments(ids: string[]): void {
  for (const id of ids) staged.delete(id)
}

/**
 * Resolves staged ids against the folder this session works in, so the model
 * is told the truth about which files its tools can reach. A file from outside
 * that folder is copied into it first — here, in the main process, so the
 * desktop and the phone get the same copy. For antichat the folder is its own
 * private one, so attaching a file is all it takes to have it edited.
 */
export async function attachmentsFor(sessionId: string, ids: string[]): Promise<AttachmentInfo[]> {
  const root = sessionFileRoot(sessionId)
  const into = sessionMode(sessionId) === 'chat' ? '' : UPLOADS_DIR
  if (ids.some((id) => !staged.has(id))) throw new AttachmentError('An attachment is no longer available. Attach it again before sending.')
  const items = ids
    .map((id) => staged.get(id))
    .filter((item): item is AttachmentInfo => item !== undefined)
    .map((item) => {
      const relative = root === null ? null : path.relative(root, item.path)
      return {
        ...item,
        workspacePath:
          relative !== null &&
          relative !== '..' &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
            ? relative
            : null
      }
    })
  if (root === null) return items
  // Sequential, so two files with one name are numbered rather than racing.
  const placed: AttachmentInfo[] = []
  for (const item of items) {
    try {
      placed.push(await placeInWorkspace(item, root, into))
    } catch (error) {
      // A read-only or odd folder still sends the prompt; the model is told
      // the file sits outside, which is then the truth.
      console.error(`Could not copy ${item.name} into the project:`, (error as Error).message)
      placed.push(item)
    }
  }
  return placed
}

export function refsOf(items: AttachmentInfo[]): AttachmentRef[] {
  return items.map(toRef)
}

export async function blocksOf(sessionId: string, items: AttachmentInfo[]): Promise<ContentBlock[]> {
  const mode = sessionMode(sessionId) ?? 'code'
  return (await Promise.all(items.map((item) => toContentBlocks(item, mode)))).flat()
}
