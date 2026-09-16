import { useState } from 'react'
import type { JSX } from 'react'
import chatLogo from '../assets/open-chat-logo.svg'

/**
 * The anticode wordmark on the new-session page. At rest it is a flat grey
 * silhouette; as the cursor comes close the lime of the icon comes back and a
 * glass plate fades in behind the mark, with a soft lime glow under it. The
 * plate is what reads as "glassmorphism" — a translucent surface with a thin
 * border and a blurred backdrop — so the logo keeps its own colours while the
 * space around it lifts off the page.
 */
export function LogoMark(): JSX.Element {
  const [near, setNear] = useState(false)

  return (
    <div
      className="group relative flex cursor-default select-none items-center justify-center rounded-3xl px-10 py-6"
      onMouseEnter={() => setNear(true)}
      onMouseLeave={() => setNear(false)}
    >
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 rounded-3xl border transition-all duration-500 ease-out ${
          near
            ? 'border-white/10 bg-white/[0.045] opacity-100 backdrop-blur-xl shadow-[0_24px_80px_-30px_rgba(209,250,34,0.45)]'
            : 'border-transparent bg-transparent opacity-0 backdrop-blur-0 shadow-none'
        }`}
      />
      <img
        src={chatLogo}
        alt="anticode"
        className={`relative w-96 transition-all duration-500 ease-out ${
          near
            ? 'opacity-100 grayscale-0 drop-shadow-[0_0_28px_rgba(209,250,34,0.35)]'
            : 'opacity-55 grayscale'
        }`}
      />
    </div>
  )
}