// Cálculo puro del ritmo de uso. Sin llamadas al modelo: solo aritmética.
import type { Calib, Limit, Snap } from '../types'

export type Kind = 'five_hour' | 'seven_day'
export type Status = 'sobrado' | 'en-ritmo' | 'adelantado' | 'agotado'

export const WINDOW_H: Record<Kind, number> = { five_hour: 5, seven_day: 168 }
/** Margen (en puntos) a partir del cual dejas de estar "en ritmo". */
const TOLERANCE = 5
const HOUR = 3_600_000

export type Pace = {
  kind: Kind
  used: number
  resetMs: number
  remH: number
  elapsedH: number
  /** % que deberías llevar si usaras el límite de forma pareja. */
  expected: number
  /** expected - used: positivo = te sobra, negativo = vas por delante. */
  margin: number
  /** % por hora que necesitas desde ahora para acabar justo en 100%. */
  needPerH: number
  /** % por hora de un uso parejo de toda la ventana. */
  idealPerH: number
  /** Tu ritmo promedio en lo que va de la ventana (%/h). */
  avgPerH: number | null
  /** % con el que terminarías si sigues a tu ritmo promedio. */
  projected: number | null
  /** Horas hasta topar al 100% a tu ritmo promedio, si ocurre antes del reset. */
  hitsLimitInH: number | null
  status: Status
  slot: SlotPace
}

/** El tramo corto dentro de la ventana: la hora actual (5h) o el día de hoy (semanal). */
export type SlotPace = {
  label: 'esta hora' | 'hoy'
  unit: '/h' | '/día'
  /** Cupo del tramo: lo que te toca usar en él para llegar al 100% justo. */
  budget: number
  /** Cupo normal de un tramo si la ventana se usara pareja. */
  normal: number
  /** Lo que ya usaste en este tramo. */
  usedInSlot: number
  /** budget - usedInSlot. */
  left: number
}

export function slotKey(kind: Kind, limit: Limit, now: number): string {
  const reset = limit.resetsAt ?? ''
  if (kind === 'seven_day') {
    const d = new Date(now)
    return `${kind}|${reset}|${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  }
  const resetMs = Date.parse(reset)
  const elapsedH = WINDOW_H.five_hour - (resetMs - now) / HOUR
  return `${kind}|${reset}|h${Math.floor(Math.max(0, elapsedH))}`
}

export function isKind(kind: string): kind is Kind {
  return kind === 'five_hour' || kind === 'seven_day'
}

export function pace(limit: Limit, now: number, snap: Snap | undefined): Pace | null {
  if (!isKind(limit.kind) || !limit.resetsAt) return null
  const resetMs = Date.parse(limit.resetsAt)
  if (Number.isNaN(resetMs)) return null

  const kind = limit.kind
  const windowH = WINDOW_H[kind]
  const used = Math.min(100, Math.max(0, limit.percentUsed))
  const remH = Math.max(0, (resetMs - now) / HOUR)
  const elapsedH = Math.min(windowH, Math.max(0, windowH - remH))
  const expected = (elapsedH / windowH) * 100
  const margin = expected - used
  const left = 100 - used
  const needPerH = remH > 0 ? left / remH : 0
  const idealPerH = 100 / windowH
  // Con muy poco tiempo transcurrido el promedio no significa nada.
  const avgPerH = elapsedH >= windowH * 0.02 ? used / elapsedH : null
  const projected = avgPerH === null ? null : Math.min(999, used + avgPerH * remH)
  const toLimit = avgPerH && avgPerH > 0 ? left / avgPerH : null
  const hitsLimitInH = toLimit !== null && toLimit < remH ? toLimit : null

  const status: Status =
    used >= 100
      ? 'agotado'
      : margin >= TOLERANCE
        ? 'sobrado'
        : margin <= -TOLERANCE
          ? 'adelantado'
          : 'en-ritmo'

  // Tramo: cuánto te toca en esta hora / hoy, recalculado con lo que había al empezarlo.
  const slotH = kind === 'five_hour' ? 1 : 24
  const startUsed = snap ? Math.min(used, snap.used) : used
  const startRemH = snap ? snap.remH : remH
  const slotsLeft = Math.max(1, startRemH / slotH)
  const budget = (100 - startUsed) / slotsLeft
  const usedInSlot = used - startUsed

  return {
    kind,
    used,
    resetMs,
    remH,
    elapsedH,
    expected,
    margin,
    needPerH,
    idealPerH,
    avgPerH,
    projected,
    hitsLimitInH,
    status,
    slot: {
      label: kind === 'five_hour' ? 'esta hora' : 'hoy',
      unit: kind === 'five_hour' ? '/h' : '/día',
      budget,
      normal: idealPerH * slotH,
      usedInSlot,
      left: budget - usedInSlot,
    },
  }
}

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
export function statusLine(paces: Pace[], plan?: WindowsPlan | null): string {
  return paces
    .map(p => {
      const name = p.kind === 'five_hour' ? '5h' : 'sem'
      const slot = p.slot
      return (
        `${STATUS_ICON[p.status]} ${name} ${p.used.toFixed(0)}%/${p.expected.toFixed(0)}% ` +
        `(${signed(p.margin)}) · ${slot.label} ${Math.max(0, slot.left).toFixed(1)}% libre ` +
        `· ↻${fmtDur(p.remH)}` +
        (p.kind === 'seven_day' && plan ? ` · ≈${plan.needed.toFixed(1)}×5h` : '')
      )
    })
    .join('  |  ')
}

// ── Equivalencia ventana de 5h ↔ límite semanal ─────────────────────────────


export const EMPTY_CALIB: Calib = { sumFive: 0, sumWeek: 0, cur: null }
/** Puntos del 5h que hay que ver subir antes de confiar en la proporción. */
const MIN_FIVE_POINTS = 10
/** Al pasar de esto se reduce a la mitad, para que pesen más las semanas recientes. */
const DECAY_AT = 600

function fold(c: Calib): Calib {
  const w = c.cur
  if (!w) return c
  const dFive = w.fiveLast - w.five0
  const dWeek = w.weekLast - w.week0
  let sumFive = c.sumFive
  let sumWeek = c.sumWeek
  if (dFive > 0 && dWeek >= 0) {
    sumFive += dFive
    sumWeek += dWeek
  }
  if (sumFive > DECAY_AT) {
    sumFive /= 2
    sumWeek /= 2
  }
  return { sumFive, sumWeek, cur: null }
}

/** Mete una lectura (5h + semanal) en la calibración. */
export function updateCalib(c: Calib, five: Limit, week: Limit): Calib {
  if (!five.resetsAt || !week.resetsAt) return c
  const w = c.cur
  const sameWindow =
    w !== null &&
    w.fiveReset === five.resetsAt &&
    w.weekReset === week.resetsAt &&
    five.percentUsed >= w.fiveLast &&
    week.percentUsed >= w.weekLast
  if (sameWindow) {
    return { ...c, cur: { ...w, fiveLast: five.percentUsed, weekLast: week.percentUsed } }
  }
  const base = fold(c)
  return {
    ...base,
    cur: {
      fiveReset: five.resetsAt,
      weekReset: week.resetsAt,
      five0: five.percentUsed,
      week0: week.percentUsed,
      fiveLast: five.percentUsed,
      weekLast: week.percentUsed,
    },
  }
}

/** Semanal (%) por cada 1% del límite de 5h; null mientras se calibra. */
export function weekPerFivePoint(c: Calib): { ratio: number | null; seenFive: number } {
  const w = c.cur
  const curFive = w ? Math.max(0, w.fiveLast - w.five0) : 0
  const curWeek = w ? Math.max(0, w.weekLast - w.week0) : 0
  const seenFive = c.sumFive + curFive
  if (seenFive < MIN_FIVE_POINTS) return { ratio: null, seenFive }
  return { ratio: (c.sumWeek + curWeek) / seenFive, seenFive }
}

export type WindowsPlan = {
  /** % semanal que consume una ventana de 5h al 100%. */
  perWindow: number
  /** Ventanas completas que faltan para agotar el semanal. */
  needed: number
  /** Las que faltarían además de terminar la actual al 100%. */
  afterCurrent: number
  /** Ventanas que caben antes del reinicio semanal (contando la actual). */
  available: number
}

export function windowsPlan(five: Pace | undefined, week: Pace, ratio: number): WindowsPlan | null {
  if (ratio <= 0) return null
  const perWindow = ratio * 100
  const left = 100 - week.used
  const currentLeft = five ? (100 - five.used) * ratio : 0
  const afterCurrent = Math.max(0, (left - currentLeft) / perWindow)
  const tail = five ? Math.max(0, week.remH - five.remH) : week.remH
  const available = Math.floor(tail / 5) + (five ? 1 : 0)
  return { perWindow, needed: left / perWindow, afterCurrent, available }
}
