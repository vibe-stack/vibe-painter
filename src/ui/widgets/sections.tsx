/**
 * Section-body helpers.
 *
 * Kept apart from `controls.tsx` so that file stays a control set rather than
 * a grab bag: these are about arranging a section's contents, not about editing
 * a value.
 */

import type { ReactNode } from 'react'

/** A minor heading inside a section body. */
export function ParamGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-2.5 text-[9px] font-semibold uppercase tracking-[0.09em] text-app-faint">
      {children}
    </div>
  )
}

/** A short note under a control, for the thing a tooltip cannot say briefly. */
export function Note({ children, tone = 'quiet' }: { children: ReactNode; tone?: 'quiet' | 'warn' }) {
  return (
    <p className={`px-2 py-1 text-[10px] leading-snug ${tone === 'warn' ? 'text-app-warn' : 'text-app-faint'}`}>
      {children}
    </p>
  )
}

/** A boxed sub-item - one generator in a mask stack, say. */
export function Card({ children, title, actions }: { children: ReactNode; title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mx-2 mb-1.5 overflow-hidden rounded-[4px] border border-app-line bg-app-bg">
      <div className="flex items-center gap-1.5 border-b border-app-line bg-app-panel/60 px-1.5 py-1">
        <div className="min-w-0 flex-1">{title}</div>
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
      <div className="py-0.5">{children}</div>
    </div>
  )
}
