/**
 * Small form controls, styled once so every panel looks like part of the same
 * tool. Kept deliberately plain - the interesting code in this project is not
 * in the widgets.
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export function Panel({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900/60 px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">{title}</h2>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block px-3 py-1.5" title={hint}>
      <span className="mb-1 block text-[11px] text-neutral-400">{label}</span>
      {children}
    </label>
  )
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  hint?: string
  onChange: (value: number) => void
}

export function Slider({ label, value, min, max, step = 0.001, hint, onChange }: SliderProps) {
  const [text, setText] = useState(format(value))
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setText(format(value))
  }, [value])

  return (
    <div className="px-3 py-1.5" title={hint}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="truncate text-[11px] text-neutral-400">{label}</span>
        <input
          className="w-16 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-right text-[11px] tabular-nums text-neutral-200 focus:border-sky-600 focus:outline-none"
          value={text}
          onFocus={() => { editing.current = true }}
          onBlur={() => {
            editing.current = false
            const parsed = Number.parseFloat(text)
            if (Number.isFinite(parsed)) onChange(clamp(parsed, min, max))
            else setText(format(value))
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        />
      </div>
      <input
        type="range"
        className="h-1 w-full cursor-pointer appearance-none rounded bg-neutral-700 accent-sky-500"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number.parseFloat(e.target.value))}
      />
    </div>
  )
}

function format(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(Math.abs(value) < 1 ? 3 : 2)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function ColorInput({ label, value, hint, onChange }: { label: string; value: [number, number, number]; hint?: string; onChange: (value: [number, number, number]) => void }) {
  const id = useId()
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5" title={hint}>
      <label htmlFor={id} className="truncate text-[11px] text-neutral-400">{label}</label>
      <input
        id={id}
        type="color"
        className="h-6 w-12 cursor-pointer rounded border border-neutral-700 bg-neutral-900"
        value={toHex(value)}
        onChange={(e) => onChange(fromHex(e.target.value))}
      />
    </div>
  )
}

function toHex([r, g, b]: [number, number, number]): string {
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

function fromHex(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

export function Select<T extends string>({ label, value, options, hint, onChange }: {
  label?: string
  value: T
  options: { value: T; label: string }[]
  hint?: string
  onChange: (value: T) => void
}) {
  const select = (
    <select
      className="w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-sky-600 focus:outline-none"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  )
  if (!label) return <div title={hint}>{select}</div>
  return <Field label={label} hint={hint}>{select}</Field>
}

export function Toggle({ label, value, hint, onChange }: { label: string; value: boolean; hint?: string; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5" title={hint}>
      <span className="truncate text-[11px] text-neutral-400">{label}</span>
      <input
        type="checkbox"
        className="h-3.5 w-3.5 cursor-pointer accent-sky-500"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}

export function Button({ children, onClick, variant = 'default', disabled, title, className = '' }: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  title?: string
  className?: string
}) {
  const styles = {
    default: 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border-neutral-700',
    primary: 'bg-sky-600 hover:bg-sky-500 text-white border-sky-500',
    ghost: 'bg-transparent hover:bg-neutral-800 text-neutral-400 border-transparent',
    danger: 'bg-transparent hover:bg-red-900/40 text-red-400 border-transparent',
  }[variant]
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  )
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 border-y border-neutral-800 bg-neutral-900/40 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
      {children}
    </div>
  )
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="px-3 py-4 text-[11px] leading-relaxed text-neutral-500">{children}</p>
}
