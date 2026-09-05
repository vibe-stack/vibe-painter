/**
 * The control set.
 *
 * Three rules hold the panels together, and every control here follows them:
 *
 *  1. **One row, one property.** A label on the left at a fixed width, its
 *     control on the right filling what is left. Rows line up down the whole
 *     panel because the label column never changes width, which is what makes a
 *     dense inspector scannable rather than merely small.
 *  2. **Numbers are draggable.** Every numeric value is a scrub handle. A
 *     slider is for coarse exploration and the field is for exact entry; both
 *     address the same value, and neither is hidden behind the other.
 *  3. **Accent means selection.** Blue is never decorative. If something is
 *     blue it is the thing currently chosen.
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/**
 * A collapsible inspector section.
 *
 * Open state is persisted per key, because the panel is a single long column
 * and which parts of it you keep open is a working preference - losing it on
 * every reload is the thing that makes stacked sections worse than tabs rather
 * than better.
 */
export function Section({
  id,
  title,
  icon,
  actions,
  defaultOpen = false,
  children,
  badge,
}: {
  id: string
  title: string
  icon?: ReactNode
  actions?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
  badge?: ReactNode
}) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen))

  const toggle = () => {
    setOpen((value) => {
      writeOpen(id, !value)
      return !value
    })
  }

  return (
    <section className="border-b border-app-line">
      <div
        className={`sticky top-0 z-10 flex items-center gap-1.5 bg-app-panel px-2 ${open ? 'py-1.5' : 'py-1.5'}`}
      >
        <button
          type="button"
          onClick={toggle}
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={open}
        >
          <span
            className={`shrink-0 text-app-faint transition-transform group-hover:text-app-muted ${open ? 'rotate-90' : ''}`}
            style={{ fontSize: 9, lineHeight: 1 }}
          >
            ▶
          </span>
          {icon && <span className="shrink-0 text-app-dim group-hover:text-app-muted">{icon}</span>}
          <span className="truncate text-[10px] font-semibold uppercase tracking-[0.07em] text-app-muted group-hover:text-app-text">
            {title}
          </span>
          {badge}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
      {open && <div className="pb-2">{children}</div>}
    </section>
  )
}

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(`vp.section.${id}`)
    return raw === null ? fallback : raw === '1'
  } catch {
    // Private windows and blocked site data both throw here rather than
    // returning null, and a panel that cannot remember its state is still a
    // working panel.
    return fallback
  }
}

function writeOpen(id: string, open: boolean): void {
  try {
    localStorage.setItem(`vp.section.${id}`, open ? '1' : '0')
  } catch {
    /* see readOpen */
  }
}

/** A labelled row. The label column width is the panel's whole rhythm. */
export function Row({
  label,
  hint,
  children,
  align = 'center',
  htmlFor,
}: {
  label?: ReactNode
  hint?: string
  children: ReactNode
  align?: 'center' | 'start'
  htmlFor?: string
}) {
  return (
    <div className={`flex gap-2 px-2 py-[3px] ${align === 'center' ? 'items-center' : 'items-start'}`} title={hint}>
      {label !== undefined && (
        <label
          htmlFor={htmlFor}
          className={`w-[88px] shrink-0 truncate text-[11px] text-app-dim ${align === 'start' ? 'pt-1' : ''}`}
        >
          {label}
        </label>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="px-2 py-2.5 text-[11px] leading-relaxed text-app-dim">{children}</p>
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

interface NumberFieldProps {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  /** Shown after the number, e.g. `°` or `px`. */
  suffix?: string
  className?: string
}

/**
 * A number you can drag.
 *
 * Pointer capture is taken on the field itself so the drag survives the cursor
 * leaving it - a scrub that stops when you overshoot the panel edge is worse
 * than no scrub at all. Sensitivity is a fraction of the range per pixel, so
 * one control feels the same whether it runs 0..1 or 0..400.
 */
export function NumberField({ value, min, max, step = 0.001, onChange, suffix, className = '' }: NumberFieldProps) {
  const [text, setText] = useState(() => format(value))
  const editing = useRef(false)
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null)

  useEffect(() => {
    if (!editing.current) setText(format(value))
  }, [value])

  const onPointerDown = (event: React.PointerEvent<HTMLInputElement>) => {
    // Let a real click through to text entry; only a movement becomes a scrub.
    drag.current = { x: event.clientX, start: value, moved: false }
    ;(event.target as HTMLInputElement).setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLInputElement>) => {
    const state = drag.current
    if (!state) return
    const dx = event.clientX - state.x
    if (!state.moved && Math.abs(dx) < 3) return
    state.moved = true
    // Fine mode while shift is held, which is what you want on a rotation.
    const range = max - min
    const perPixel = (range / 260) * (event.shiftKey ? 0.15 : 1)
    const next = clamp(quantise(state.start + dx * perPixel, step), min, max)
    onChange(next)
    setText(format(next))
  }

  const onPointerUp = (event: React.PointerEvent<HTMLInputElement>) => {
    const state = drag.current
    drag.current = null
    if (state?.moved) {
      // A scrub is not a click; do not drop a caret into the field afterwards.
      ;(event.target as HTMLInputElement).blur()
    }
  }

  const commit = () => {
    editing.current = false
    const parsed = Number.parseFloat(text)
    if (Number.isFinite(parsed)) {
      const next = clamp(parsed, min, max)
      onChange(next)
      setText(format(next))
    } else {
      setText(format(value))
    }
  }

  return (
    <div className={`relative ${className}`}>
      <input
        className="scrub w-full rounded-[3px] border border-transparent bg-app-raised px-1.5 py-[3px] text-right text-[11px] tabular-nums text-app-text outline-none transition-colors hover:border-app-line-strong focus:cursor-text focus:border-app-accent focus:bg-app-bg focus:select-text"
        value={text}
        inputMode="decimal"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onFocus={() => {
          editing.current = true
        }}
        onBlur={commit}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          if (event.key === 'Escape') {
            setText(format(value))
            ;(event.target as HTMLInputElement).blur()
          }
          // Arrow keys nudge, which is how every other inspector behaves.
          const direction = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0
          if (direction !== 0) {
            event.preventDefault()
            const unit = step > 0 ? step : (max - min) / 100
            const next = clamp(quantise(value + direction * unit * (event.shiftKey ? 10 : 1), step), min, max)
            onChange(next)
            setText(format(next))
          }
        }}
      />
      {suffix && (
        <span className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center text-[10px] text-app-faint">
          {suffix}
        </span>
      )}
    </div>
  )
}

/**
 * A slider and its number field, addressing one value.
 *
 * `curve="log"` spaces the *track* logarithmically while the field keeps
 * showing the real number. That is not a cosmetic choice: a brush radius runs
 * from a fraction of a texel to the whole model, and on a linear track the
 * entire useful range for detail work lives in the first two pixels of travel.
 * Requires a positive `min`, which is the only range a log scale has anyway.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 0.001,
  hint,
  suffix,
  curve = 'linear',
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  hint?: string
  suffix?: string
  curve?: 'linear' | 'log'
  onChange: (value: number) => void
}) {
  const logarithmic = curve === 'log' && min > 0 && max > min
  const span = Math.log(max / (logarithmic ? min : 1))
  const toFraction = (v: number): number => {
    const clamped = clamp(v, min, max)
    if (logarithmic) return span > 0 ? Math.log(clamped / min) / span : 0
    return max > min ? (clamped - min) / (max - min) : 0
  }
  const fromFraction = (f: number): number =>
    logarithmic ? min * Math.exp(span * clamp(f, 0, 1)) : min + clamp(f, 0, 1) * (max - min)

  const fraction = toFraction(value)
  return (
    <Row label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          {/* The filled part of the track, drawn under the native input. */}
          <div className="pointer-events-none absolute left-0 right-0 h-[3px] rounded-full bg-app-raised" />
          <div
            className="pointer-events-none absolute left-0 h-[3px] rounded-full bg-app-accent"
            style={{ width: `${fraction * 100}%` }}
          />
          <input
            type="range"
            className="track relative h-[11px] w-full cursor-pointer"
            min={logarithmic ? 0 : min}
            max={logarithmic ? 1 : max}
            step={logarithmic ? 0.0005 : step}
            value={logarithmic ? fraction : clamp(value, min, max)}
            onChange={(event) => {
              const raw = Number.parseFloat(event.target.value)
              onChange(logarithmic ? fromFraction(raw) : raw)
            }}
          />
        </div>
        <NumberField
          value={value}
          min={min}
          max={max}
          step={step}
          suffix={suffix}
          onChange={onChange}
          className="w-[54px] shrink-0"
        />
      </div>
    </Row>
  )
}

function format(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(Math.abs(value) < 10 ? 3 : 2).replace(/\.?0+$/, '')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function quantise(value: number, step: number): number {
  if (!step || step <= 0) return value
  return Math.round(value / step) * step
}

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

/**
 * A segmented control: the right shape for two to four mutually exclusive
 * options, because every choice stays visible and costs one click.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  hint,
  onChange,
}: {
  label?: string
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  hint?: string
  onChange: (value: T) => void
}) {
  const control = (
    <div className="flex rounded-[3px] bg-app-bg p-[2px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          onClick={() => onChange(option.value)}
          className={`min-w-0 flex-1 truncate rounded-[2px] px-1.5 py-[3px] text-[11px] transition-colors ${
            value === option.value
              ? 'bg-app-accent text-white'
              : 'text-app-muted hover:bg-app-raised hover:text-app-text'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
  if (!label) return <div className="px-2 py-[3px]">{control}</div>
  return <Row label={label} hint={hint}>{control}</Row>
}

export function Select<T extends string>({
  label,
  value,
  options,
  hint,
  onChange,
}: {
  label?: string
  value: T
  options: { value: T; label: string }[]
  hint?: string
  onChange: (value: T) => void
}) {
  const select = (
    <select
      className="w-full cursor-pointer appearance-none rounded-[3px] border border-transparent bg-app-raised px-1.5 py-[3px] text-[11px] text-app-text outline-none transition-colors hover:border-app-line-strong focus:border-app-accent"
      style={{
        // A chevron drawn into the background, because the native one cannot be
        // recoloured and reads as light-mode chrome on a dark panel.
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'><path d='M0 0h8L4 5z' fill='%23888891'/></svg>\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 6px center',
        paddingRight: 18,
      }}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
  if (!label) return <div className="px-2 py-[3px]">{select}</div>
  return <Row label={label} hint={hint}>{select}</Row>
}

/** A switch, not a checkbox: it reads as state rather than as a form field. */
export function Toggle({
  label,
  value,
  hint,
  onChange,
}: {
  label: string
  value: boolean
  hint?: string
  onChange: (value: boolean) => void
}) {
  return (
    <Row label={label} hint={hint}>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative h-[15px] w-[26px] shrink-0 rounded-full transition-colors ${
          value ? 'bg-app-accent' : 'bg-app-raised hover:bg-app-hover'
        }`}
      >
        <span
          className="absolute top-[2px] h-[11px] w-[11px] rounded-full bg-white transition-all"
          style={{ left: value ? 13 : 2 }}
        />
      </button>
    </Row>
  )
}

export function ColorInput({
  label,
  value,
  hint,
  onChange,
}: {
  label: string
  value: [number, number, number]
  hint?: string
  onChange: (value: [number, number, number]) => void
}) {
  const id = useId()
  const hex = toHex(value)
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <div className="flex items-center gap-1.5">
        <label
          htmlFor={id}
          className="h-[18px] w-[26px] shrink-0 cursor-pointer rounded-[3px] border border-app-line-strong"
          style={{ backgroundColor: hex }}
        />
        <input
          id={id}
          type="color"
          className="sr-only"
          value={hex}
          onChange={(event) => onChange(fromHex(event.target.value))}
        />
        <span className="select-all font-mono text-[10px] uppercase tracking-wide text-app-dim">{hex.slice(1)}</span>
      </div>
    </Row>
  )
}

function toHex([r, g, b]: [number, number, number]): string {
  const to = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

function fromHex(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

export function TextInput({
  label,
  value,
  placeholder,
  hint,
  onChange,
}: {
  label?: string
  value: string
  placeholder?: string
  hint?: string
  onChange: (value: string) => void
}) {
  const input = (
    <input
      className="w-full rounded-[3px] border border-transparent bg-app-raised px-1.5 py-[3px] text-[11px] text-app-text outline-none transition-colors placeholder:text-app-faint hover:border-app-line-strong focus:border-app-accent focus:bg-app-bg"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  )
  if (!label) return <div className="px-2 py-[3px]">{input}</div>
  return <Row label={label} hint={hint}>{input}</Row>
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  title,
  className = '',
  full,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'subtle'
  disabled?: boolean
  title?: string
  className?: string
  full?: boolean
}) {
  const styles = {
    default: 'bg-app-raised hover:bg-app-hover text-app-text border-app-line',
    primary: 'bg-app-accent hover:bg-app-accent-hi text-white border-transparent',
    ghost: 'bg-transparent hover:bg-app-raised text-app-dim hover:text-app-text border-transparent',
    subtle: 'bg-transparent hover:bg-app-raised text-app-muted border-app-line',
    danger: 'bg-transparent hover:bg-app-danger/20 text-app-danger border-transparent',
  }[variant]
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-[3px] border px-2 py-[3px] text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${full ? 'w-full' : ''} ${className}`}
    >
      {children}
    </button>
  )
}

/** A square icon button, for section headers and row affordances. */
export function IconButton({
  children,
  onClick,
  title,
  active,
  danger,
}: {
  children: ReactNode
  onClick?: () => void
  title: string
  active?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.()
      }}
      className={`flex h-[18px] w-[18px] items-center justify-center rounded-[3px] text-[11px] leading-none transition-colors ${
        active
          ? 'bg-app-accent text-white'
          : danger
            ? 'text-app-dim hover:bg-app-danger/20 hover:text-app-danger'
            : 'text-app-dim hover:bg-app-raised hover:text-app-text'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * The scrolling body of a sidebar column.
 *
 * `min-h-0` is load-bearing: without it a flex child refuses to shrink below
 * its content, so the column grows past the viewport and the whole page
 * scrolls instead of the panel.
 */
export function ScrollArea({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden ${className}`}>{children}</div>
}
