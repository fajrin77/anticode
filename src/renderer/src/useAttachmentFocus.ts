import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** Focus only newly added attachments, not removal or switching drafts. */
export function useAttachmentFocus(
  draftId: string | undefined,
  attachments: readonly { id: string }[],
  field: RefObject<HTMLTextAreaElement | null>
): void {
  const previous = useRef({ draftId, ids: new Set(attachments.map(item => item.id)) })
  useEffect(() => {
    const before = previous.current
    previous.current = { draftId, ids: new Set(attachments.map(item => item.id)) }
    if (before.draftId === draftId && attachments.some(item => !before.ids.has(item.id))) {
      field.current?.focus({ preventScroll: true })
    }
  }, [draftId, attachments, field])
}
