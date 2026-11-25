import { Fragment } from 'react'
import type { JSX } from 'react'
import { SHORTCUT_GROUPS, isMac, keyLabel } from '../../shortcuts'

function Keys({ keys, mac }: { keys: string[]; mac: boolean }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {keys.map((token, index) => (
        <kbd key={index}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-line bg-raised px-1.5 font-mono text-[11.5px] text-text">
          {keyLabel(token, mac)}
        </kbd>
      ))}
    </span>
  )
}

/** Every key the app answers to, listed from shortcuts.ts so it never drifts from the handlers. */
export function Shortcuts(): JSX.Element {
  const mac = isMac()
  return (
    <>
      <h1 className="mb-2 text-[19px] text-text">Shortcuts</h1>
      <p className="mb-6 text-[12.5px] text-dim">
        Press <Keys keys={['Mod', '/']} mac={mac} /> anywhere to come back to this list.
      </p>
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.title} className="mb-8" aria-label={group.title}>
          <h2 className="mb-1 text-[14px] text-text">{group.title}</h2>
          {group.hint !== undefined && <p className="mb-2 text-[12px] text-faint">{group.hint}</p>}
          <div className="glass-surface mt-2 overflow-hidden rounded-xl border border-line">
            {group.items.map((item) => (
              <div key={item.action} className="flex items-center gap-6 border-b border-line-soft px-5 py-3 last:border-b-0">
                <span className="min-w-0 flex-1 text-[13px] text-text">{item.action}</span>
                <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-faint">
                  {item.keys.map((keys, index) => (
                    <Fragment key={index}>
                      {index > 0 && <span>or</span>}
                      <Keys keys={keys} mac={mac} />
                    </Fragment>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}
