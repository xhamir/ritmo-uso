// Cálculo puro del ritmo de uso. Sin llamadas al modelo: solo aritmética.
import type { Calib, Closed, Limit, Reading, Snap } from '../types'

export type Kind = 'five_hour' | 'seven_day'
export type Status = 'sobrado' | 'en-ritmo' | 'adelantado' | 'agotado'
/** Horario activo en horas locales [start, end); start > end cruza la medianoche. */
export type Schedule = { start: number; end: number }

export const ALWAYS: Schedule = { start: 0, end: 24 }
export const WINDOW_H: Record<Kind, number> = { five_hour: 5, seven_day: 168 }
const HOUR = 3_600_000

export function isKind(kind: string): kind is Kind {
  return kind === 'five_hour' || kind === 'seven_day'
}

function isAlways(s: Schedule): boolean {
  return s.start === s.end || (s.start <= 0 && s.end >= 24)
}

function localMidnight(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** La hora local `h` (0-24) del día que empieza en `day`, respetando cambios de horario. */
function atHour(day: number, h: number): number {
  const d = new Date(day)
  d.setHours(h, 0, 0, 0)
  return d.getTime()
}

function nextMidnight(ms: number): number {
  const d = new Date(localMidnight(ms))
  d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** Horas dentro del horario activo entre a y b. */
export function activeHours(a: number, b: number, s: Schedule): number {
  if (b <= a) return 0
  if (isAlways(s)) return (b - a) / HOUR
  const ranges = s.start < s.end ? [[s.start, s.end]] : [[0, s.end], [s.start, 24]]
  let total = 0
  for (let day = localMidnight(a); day < b; ) {
    const next = new Date(day)
    next.setDate(next.getDate() + 1)
    const nextDay = next.getTime()
    for (const [h0, h1] of ranges) {
      const x0 = Math.max(a, atHour(day, h0!))
      const x1 = Math.min(b, atHour(day, h1!), nextDay)
      if (x1 > x0) total += x1 - x0
    }
    day = nextDay
  }
  return total / HOUR
}

/** Momento en que se acumulan `hours` horas activas desde `from` (búsqueda binaria). */
function addActive(from: number, hours: number, limit: number, s: Schedule): number {
  let lo = from
  let hi = limit
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2
    if (activeHours(from, mid, s) < hours) lo = mid
    else hi = mid
  }
  return hi
}

export type Pace = {
  kind: Kind
  used: number
  resetMs: number
  /** Horas de reloj hasta el reinicio. */
  remH: number
  /** Horas activas hasta el reinicio (igual a remH en el 5h). */
  remActiveH: number
  /** % que deberías llevar con un uso parejo dentro de tu horario. */
  expected: number
  /** expected - used: positivo = te sobra, negativo = vas por delante. */
  margin: number
  /** % por hora activa que necesitas para acabar justo en 100%. */
  needPerH: number
  /** % por hora activa de un uso parejo de toda la ventana. */
  idealPerH: number
  avgPerH: number | null
  /** % con el que terminarías a tu ritmo promedio. */
  projected: number | null
  /** Cuándo topas el 100% a tu ritmo promedio, si es antes del reinicio. */
  hitsAtMs: number | null
  status: Status
  slot: SlotPace
}

export type SlotPace = {
  label: 'esta hora' | 'hoy'
  /** Lo que te toca usar en este tramo para llegar al 100% justo. */
  budget: number
  /** Cupo normal del tramo con uso parejo. */
  normal: number
  usedInSlot: number
  left: number
}

export function slotKey(kind: Kind, limit: Limit, now: number): string {
  const reset = limit.resetsAt ?? ''
  if (kind === 'seven_day') {
    const d = new Date(now)
    return `${kind}|${reset}|${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  }
  const elapsedH = WINDOW_H.five_hour - (Date.parse(reset) - now) / HOUR
  return `${kind}|${reset}|h${Math.floor(Math.max(0, elapsedH))}`
}

export function pace(
  limit: Limit,
  now: number,
  snap: Snap | undefined,
  schedule: Schedule = ALWAYS,
  tolerance = 5,
): Pace | null {
  if (!isKind(limit.kind) || !limit.resetsAt) return null
  const resetMs = Date.parse(limit.resetsAt)
  if (Number.isNaN(resetMs)) return null

  const kind = limit.kind
  // El horario solo aplica al semanal: una ventana de 5h ya es tiempo activo.
  let s = kind === 'seven_day' ? schedule : ALWAYS
  const windowStart = resetMs - WINDOW_H[kind] * HOUR
  if (activeHours(windowStart, resetMs, s) <= 0) s = ALWAYS
  const totalA = activeHours(windowStart, resetMs, s)
  const elapsedA = activeHours(windowStart, Math.min(now, resetMs), s)
  const remActiveH = activeHours(Math.max(now, windowStart), resetMs, s)
  const remH = Math.max(0, (resetMs - now) / HOUR)

  const used = Math.min(100, Math.max(0, limit.percentUsed))
  const left = 100 - used
  const expected = (elapsedA / totalA) * 100
  const margin = expected - used
  const needPerH = remActiveH > 0 ? left / remActiveH : 0
  const idealPerH = 100 / totalA
  const avgPerH = elapsedA >= totalA * 0.02 ? used / elapsedA : null
  const projected = avgPerH === null ? null : Math.min(999, used + avgPerH * remActiveH)
  const toLimit = avgPerH && avgPerH > 0 ? left / avgPerH : null
  const hitsAtMs =
    toLimit !== null && toLimit < remActiveH ? addActive(now, toLimit, resetMs, s) : null

  const status: Status =
    used >= 100
      ? 'agotado'
      : margin >= tolerance
        ? 'sobrado'
        : margin <= -tolerance
          ? 'adelantado'
          : 'en-ritmo'

  const startUsed = snap ? Math.min(used, snap.used) : used
  let budget: number
  let normal: number
  if (kind === 'five_hour') {
    const startRemH = snap ? snap.remH : remH
    budget = (100 - startUsed) / Math.max(1, startRemH)
    normal = 100 / WINDOW_H.five_hour
  } else {
    const m0 = Math.max(localMidnight(now), windowStart)
    const m1 = Math.min(nextMidnight(now), resetMs)
    const dayA = activeHours(m0, m1, s)
    const fromDayA = activeHours(m0, resetMs, s)
    budget = fromDayA > 0 ? ((100 - startUsed) * dayA) / fromDayA : 100 - startUsed
    normal = (dayA / totalA) * 100
  }
  const usedInSlot = used - startUsed

  return {
    kind,
    used,
    resetMs,
    remH,
    remActiveH,
    expected,
    margin,
    needPerH,
    idealPerH,
    avgPerH,
    projected,
    hitsAtMs,
    status,
    slot: {
      label: kind === 'five_hour' ? 'esta hora' : 'hoy',
      budget,
      normal,
      usedInSlot,
      left: budget - usedInSlot,
    },
  }
}

// ── Tramos: % al empezar la hora / el día ──────────────────────────────────

/**
 * Snaps para los tramos actuales que aún no tienen uno. El inicio del tramo se
 * toma de la lectura anterior de la misma ventana, así el uso hecho fuera de
 * Claude Code (p. ej. en la web) antes de la primera lectura cuenta como de hoy.
 */
export function newSnaps(current: Snap[], prev: Reading | null, reading: Reading, now: number): Snap[] {
  const fresh: Snap[] = []
  for (const limit of reading.limits) {
    if (!isKind(limit.kind) || !limit.resetsAt) continue
    if (Date.parse(limit.resetsAt) <= now) continue
    const key = slotKey(limit.kind, limit, now)
    if (current.some(s => s.key === key)) continue
    // La lectura anterior solo vale como inicio si es del tramo inmediatamente anterior.
    const maxGap = limit.kind === 'five_hour' ? HOUR : 24 * HOUR
    const recent = prev && now - prev.observedAt <= maxGap ? prev : null
    const before = recent?.limits.find(l => l.kind === limit.kind && l.resetsAt === limit.resetsAt)
    const used = before ? Math.min(before.percentUsed, limit.percentUsed) : limit.percentUsed
    const remH = Math.max(0, (Date.parse(limit.resetsAt) - now) / HOUR)
    fresh.push({ key, used, remH })
  }
  return fresh
}

// ── Equivalencia ventana de 5h ↔ semanal, por modelo ────────────────────────

export const EMPTY_CALIB: Calib = { byModel: {}, last: null }
/** Puntos del 5h que hay que ver subir antes de confiar en la proporción. */
const MIN_FIVE_POINTS = 10
/** Al pasar de esto se reduce a la mitad, para que pesen más las semanas recientes. */
const DECAY_AT = 600

export function modelFamily(model: string | undefined): string | null {
  if (!model) return null
  const m = model.toLowerCase().match(/opus|sonnet|haiku|fable/)
  return m ? m[0] : model.toLowerCase()
}

export const MODEL_LABEL = (family: string) =>
  family.charAt(0).toUpperCase() + family.slice(1)

/**
 * Mete una lectura en la calibración. El delta desde la lectura anterior se
 * atribuye a `family` (el único modelo usado entre ambas); con null se descarta.
 */
/** Una lectura anterior más vieja que esto ya no se compara (pudo haber uso sin ver). */
const MAX_CALIB_GAP = 30 * 60_000

export function updateCalib(c: Calib, five: Limit, week: Limit, family: string | null, now = 0): Calib {
  if (!five.resetsAt || !week.resetsAt) return c
  const last = c.last
  let byModel = c.byModel
  const fresh = !now || (last?.at !== undefined && now - last.at <= MAX_CALIB_GAP)
  if (
    family &&
    fresh &&
    last &&
    last.fiveReset === five.resetsAt &&
    last.weekReset === week.resetsAt
  ) {
    const dFive = five.percentUsed - last.five
    const dWeek = week.percentUsed - last.week
    if (dFive >= 0 && dWeek >= 0 && dFive + dWeek > 0) {
      const prev = byModel[family] ?? { five: 0, week: 0 }
      let next = { five: prev.five + dFive, week: prev.week + dWeek }
      if (next.five > DECAY_AT) next = { five: next.five / 2, week: next.week / 2 }
      byModel = { ...byModel, [family]: next }
    }
  }
  return {
    byModel,
    last: {
      fiveReset: five.resetsAt,
      weekReset: week.resetsAt,
      five: five.percentUsed,
      week: week.percentUsed,
      ...(now ? { at: now } : {}),
    },
  }
}

/** Semanal (%) por cada 1% del 5h; sin `family`, todos los modelos juntos. */
export function weekPerFivePoint(c: Calib, family?: string | null): { ratio: number | null; seenFive: number } {
  const entries = family ? [c.byModel[family]].filter(Boolean) : Object.values(c.byModel)
  let five = 0
  let week = 0
  for (const e of entries) {
    five += e!.five
    week += e!.week
  }
  if (five < MIN_FIVE_POINTS) return { ratio: null, seenFive: five }
  return { ratio: week / five, seenFive: five }
}

export type WindowsPlan = {
  perWindow: number
  needed: number
  afterCurrent: number
  available: number
}

export function windowsPlan(
  five: Pace | undefined,
  week: Pace,
  ratio: number,
  schedule: Schedule = ALWAYS,
): WindowsPlan | null {
  if (ratio <= 0) return null
  const perWindow = ratio * 100
  const left = 100 - week.used
  const currentLeft = five ? (100 - five.used) * ratio : 0
  const afterCurrent = Math.max(0, (left - currentLeft) / perWindow)
  const tail = five ? activeHours(five.resetMs, week.resetMs, schedule) : week.remActiveH
  const available = Math.floor(tail / 5) + (five ? 1 : 0)
  return { perWindow, needed: left / perWindow, afterCurrent, available }
}

// ── Desperdicio: con qué % cerró cada ventana ──────────────────────────────

/** Ventanas que cerraron entre `prev` y ahora (cambió su reset o ya pasó). */
export function closedWindows(prev: Reading | null, next: Reading | null, now: number, history: Closed[]): Closed[] {
  if (!prev) return []
  const out: Closed[] = []
  for (const l of prev.limits) {
    if (!isKind(l.kind) || !l.resetsAt) continue
    const reset = l.resetsAt
    const replaced = next?.limits.some(n => n.kind === l.kind && n.resetsAt && n.resetsAt !== reset)
    const expired = Date.parse(reset) <= now
    if (!replaced && !expired) continue
    if (history.some(h => h.kind === l.kind && h.reset === reset)) continue
    if (out.some(h => h.kind === l.kind && h.reset === reset)) continue
    out.push({ kind: l.kind, reset, final: Math.min(100, l.percentUsed) })
  }
  return out
}

export function trimHistory(history: Closed[]): Closed[] {
  const five = history.filter(h => h.kind === 'five_hour').slice(-60)
  const week = history.filter(h => h.kind === 'seven_day').slice(-12)
  return [...five, ...week]
}

export function wasteSummary(history: Closed[], kind: Kind, n: number) {
  const finals = history.filter(h => h.kind === kind).slice(-n).map(h => h.final)
  const avg = finals.length ? finals.reduce((a, b) => a + b, 0) / finals.length : null
  return { finals, avg }
}

// ── Alertas ────────────────────────────────────────────────────────────────

export type Alert = { key: string; text: string }

export function alertsFor(paces: Pace[], plan: WindowsPlan | null, now: number): Alert[] {
  const out: Alert[] = []
  const five = paces.find(p => p.kind === 'five_hour')
  const week = paces.find(p => p.kind === 'seven_day')
  const reset = (p: Pace) => String(p.resetMs)

  if (five && five.status !== 'agotado') {
    const left = 100 - five.used
    if (five.remH <= 0.75 && left >= 25) {
      out.push({
        key: `waste5|${reset(five)}`,
        text: `⏳ Quedan ${fmtDur(five.remH)} de la ventana de 5h y tienes ${pct(left)} sin usar: aprovecha para tareas pesadas.`,
      })
    }
    if (five.hitsAtMs !== null && five.used >= 40 && five.resetMs - five.hitsAtMs > 30 * 60_000) {
      out.push({
        key: `cap5|${reset(five)}`,
        text: `🔴 A este ritmo topas el límite de 5h a las ${fmtClock(five.hitsAtMs, false)}, ${fmtDur((five.resetMs - five.hitsAtMs) / HOUR)} antes del reinicio.`,
      })
    }
  }

  if (week && week.status !== 'agotado') {
    if (week.hitsAtMs !== null && week.resetMs - week.hitsAtMs > 6 * HOUR) {
      const d = new Date(now)
      out.push({
        key: `cap7|${reset(week)}|${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`,
        text: `🔴 A este ritmo topas el semanal el ${fmtClock(week.hitsAtMs, true)}: baja el ritmo o usa Sonnet.`,
      })
    }
    const left = 100 - week.used
    const lotsLeft = plan ? plan.needed > plan.available * 0.5 : left >= 30
    if (week.remH <= 36 && left >= 20 && lotsLeft) {
      out.push({
        key: `waste7|${reset(week)}`,
        text: `🟢 Quedan ${fmtDur(week.remH)} del semanal y te sobra ${pct(left)}: úsalo sin miedo (Opus incluido).`,
      })
    }
  }
  return out
}

// ── Formato ────────────────────────────────────────────────────────────────

export function fmtDur(hours: number): string {
  const totalMin = Math.max(0, Math.round(hours * 60))
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m`
}

export function fmtClock(ms: number, withDay: boolean): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (!withDay) return `${hh}:${mm}`
  const days = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
  return `${days[d.getDay()]} ${hh}:${mm}`
}

export const pct = (n: number) => `${n.toFixed(1)}%`
export const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`

export const STATUS_ICON: Record<Status, string> = {
  sobrado: '🟢',
  'en-ritmo': '🟡',
  adelantado: '🔴',
  agotado: '⛔',
}

export const STATUS_TEXT: Record<Status, string> = {
  sobrado: 'SOBRADO — puedes usar más',
  'en-ritmo': 'EN RITMO',
  adelantado: 'ADELANTADO — riesgo de topar antes del reset',
  agotado: 'AGOTADO',
}

/** Línea compacta para la barra de estado. */
export function statusLine(paces: Pace[], windowsText?: string | null): string {
  return paces
    .map(p => {
      const name = p.kind === 'five_hour' ? '5h' : 'sem'
      return (
        `${STATUS_ICON[p.status]} ${name} ${p.used.toFixed(0)}%/${p.expected.toFixed(0)}% ` +
        `(${signed(p.margin)}) · ${p.slot.label} ${Math.max(0, p.slot.left).toFixed(1)}% libre ` +
        `· ↻${fmtDur(p.remH)}` +
        (p.kind === 'seven_day' && windowsText ? ` · ${windowsText}` : '')
      )
    })
    .join('  |  ')
}
