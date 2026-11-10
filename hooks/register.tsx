import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Calib, Closed, Limit, Reading, Snap } from '../types'
import {
  EMPTY_CALIB,
  MODEL_LABEL,
  STATUS_ICON,
  STATUS_TEXT,
  alertsFor,
  closedWindows,
  fmtClock,
  fmtDur,
  isKind,
  modelFamily,
  newSnaps,
  pace,
  pct,
  signed,
  slotKey,
  statusLine,
  trimHistory,
  updateCalib,
  wasteSummary,
  weekPerFivePoint,
  windowsPlan,
} from './pace'
import type { Pace, Schedule, WindowsPlan } from './pace'

type Api = EngineInterface

const PANE = 'ritmo-uso'
const TITLE = 'Ritmo de uso'

const readingAtom = atom({ plugin: 'ritmo-uso', key: 'reading' } as const, null)
const snapsAtom = atom({ plugin: 'ritmo-uso', key: 'snaps' } as const, [])
const tickAtom = atom({ plugin: 'ritmo-uso', key: 'tick' } as const, 0)
const calibAtom = atom({ plugin: 'ritmo-uso', key: 'calib' } as const, EMPTY_CALIB, {
  shape: 'calib-2',
})
const historyAtom = atom({ plugin: 'ritmo-uso', key: 'history' } as const, [])
const modelAtom = atom({ plugin: 'ritmo-uso', key: 'model' } as const, '')

type Settings = { schedule: Schedule; tolerance: number; alerts: boolean }

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function settingsFrom(options: PluginOptions): Settings {
  return {
    schedule: {
      start: num(options.horaInicio, 9, 0, 23),
      end: num(options.horaFin, 24, 1, 24),
    },
    tolerance: num(options.tolerancia, 5, 1, 50),
    alerts: options.alertas !== false,
  }
}

/** Calibración guardada por la versión 0.2 (una sola proporción, sin modelo). */
function migrateCalib(v: unknown): Calib | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.byModel && typeof o.byModel === 'object') return v as Calib
  if (typeof o.sumFive === 'number' && typeof o.sumWeek === 'number') {
    const cur = o.cur as { five0: number; fiveLast: number; week0: number; weekLast: number } | null
    const five = o.sumFive + (cur ? Math.max(0, cur.fiveLast - cur.five0) : 0)
    const week = o.sumWeek + (cur ? Math.max(0, cur.weekLast - cur.week0) : 0)
    return five > 0 ? { byModel: { mixto: { five, week } }, last: null } : EMPTY_CALIB
  }
  return null
}

const DEFAULT_SETTINGS: Settings = { schedule: { start: 9, end: 24 }, tolerance: 5, alerts: true }
/** Opciones del usuario; se fijan en cada carga del módulo. */
let cfg: Settings = DEFAULT_SETTINGS
/** Modelos que respondieron desde la última lectura de límites. */
let pending = new Set<string>()
/** La primera lectura de cada carga no se atribuye: puede haber uso que no vimos. */
let isFirstIngest = true

function computePaces(reading: Reading | null, snaps: Snap[], now: number): Pace[] {
  if (!reading) return []
  const out: Pace[] = []
  for (const limit of reading.limits) {
    const kind = limit.kind
    if (!isKind(kind)) continue
    const snap = snaps.find(s => s.key === slotKey(kind, limit, now))
    const p = pace(limit, now, snap, cfg.schedule, cfg.tolerance)
    if (p && p.remH > 0) out.push(p)
  }
  return out.sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : 0))
}

function planFor(paces: Pace[], calib: Calib, family: string | null): WindowsPlan | null {
  const week = paces.find(p => p.kind === 'seven_day')
  if (!week) return null
  const own = family ? weekPerFivePoint(calib, family).ratio : null
  const ratio = own ?? weekPerFivePoint(calib).ratio
  if (ratio === null) return null
  return windowsPlan(paces.find(p => p.kind === 'five_hour'), week, ratio, cfg.schedule)
}

async function addSnaps($: Api, prev: Reading | null, reading: Reading, now: number) {
  const current = await read($, snapsAtom)
  if (newSnaps(current, prev, reading, now).length === 0) return
  await update($, snapsAtom, list => [...list, ...newSnaps(list, prev, reading, now)].slice(-20))
  await $.store.set('snaps', await read($, snapsAtom))
}

async function recordClosed($: Api, prev: Reading | null, next: Reading | null, now: number) {
  if (closedWindows(prev, next, now, await read($, historyAtom)).length === 0) return
  // Fusiona con lo que guardaron otras sesiones abiertas a la vez.
  const stored = ((await $.store.get('history')) as Closed[] | undefined) ?? []
  await update($, historyAtom, list => {
    const merged = [...list]
    for (const h of stored) {
      if (!merged.some(m => m.kind === h.kind && m.reset === h.reset)) merged.push(h)
    }
    return trimHistory([...merged, ...closedWindows(prev, next, now, merged)])
  })
  await $.store.set('history', await read($, historyAtom))
}

async function raiseAlerts($: Api, paces: Pace[], plan: WindowsPlan | null, now: number) {
  if (!cfg.alerts) return
  const alerts = alertsFor(paces, plan, now)
  if (alerts.length === 0) return
  const seen = ((await $.store.get('alerted')) as string[] | undefined) ?? []
  const fresh = alerts.filter(a => !seen.includes(a.key))
  if (fresh.length === 0) return
  for (const a of fresh) $.ui.toast(a.text, { timeoutMs: 12_000 })
  await $.store.set('alerted', [...seen, ...fresh.map(a => a.key)].slice(-50))
}

async function refresh($: Api) {
  const now = await $.clock.now()
  const paces = computePaces(await read($, readingAtom), await read($, snapsAtom), now)
  const calib = await read($, calibAtom)
  const family = (await read($, modelAtom)) || null
  const plan = planFor(paces, calib, family)
  const windowsText = plan
    ? `≈${plan.needed.toFixed(1)}×5h${family && weekPerFivePoint(calib, family).ratio !== null ? ` (${family})` : ''}`
    : null
  $.ui.status(paces.length ? statusLine(paces, windowsText) : undefined)
  await raiseAlerts($, paces, plan, now)
}

async function ingest($: Api, limits: Limit[]) {
  const relevant = limits.filter(l => isKind(l.kind))
  if (relevant.length === 0) return
  const now = await $.clock.now()
  const prev = await read($, readingAtom)
  const reading: Reading = {
    limits: relevant.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    observedAt: now,
  }
  await recordClosed($, prev, reading, now)
  await update($, readingAtom, () => reading)
  await $.store.set('reading', reading)
  await addSnaps($, prev, reading, now)

  // Atribuye el delta al modelo, solo si entre lecturas respondió uno solo.
  const sessionFamily = modelFamily(await $.session.model())
  // Sin turnos registrados (la lectura llegó antes que turn.complete) se usa el
  // modelo de la sesión, salvo en la primera lectura de la carga.
  const families = pending.size ? [...pending] : sessionFamily && !isFirstIngest ? [sessionFamily] : []
  pending = new Set()
  isFirstIngest = false
  const family = families.length === 1 ? families[0]! : null
  if (sessionFamily) await update($, modelAtom, () => sessionFamily)

  const five = relevant.find(l => l.kind === 'five_hour')
  const week = relevant.find(l => l.kind === 'seven_day')
  if (five && week) {
    const calib = updateCalib(await read($, calibAtom), five, week, family, now)
    await update($, calibAtom, () => calib)
    await $.store.set('calib', calib)
  }
  await refresh($)
}

export const register: Register = (on, options) => {
  cfg = settingsFrom(options)
  pending = new Set()
  isFirstIngest = true

  on('session.start', async ($, e, next) => {
    const result = await next(e)

    // Últimos valores conocidos (de otra sesión) para mostrar algo al instante.
    const stored = (await $.store.get('reading')) as Reading | undefined
    const storedSnaps = (await $.store.get('snaps')) as Snap[] | undefined
    const storedHistory = (await $.store.get('history')) as Closed[] | undefined
    const storedCalib = migrateCalib(await $.store.get('calib'))
    if (Array.isArray(storedSnaps)) await update($, snapsAtom, () => storedSnaps)
    if (Array.isArray(storedHistory)) await update($, historyAtom, () => storedHistory)
    if (storedCalib) await update($, calibAtom, () => storedCalib)
    if (stored && Array.isArray(stored.limits)) await update($, readingAtom, () => stored)
    const family = modelFamily(await $.session.model())
    if (family) await update($, modelAtom, () => family)

    await $.command.register({
      name: 'ritmo',
      description: 'Abre el panel de ritmo de uso (límite 5h y semanal)',
    })

    const usage = await $.session.usage()
    if (usage.rateLimits.length) await ingest($, usage.rateLimits)
    else await refresh($)

    // Cada minuto: el tiempo avanza aunque no haya respuestas nuevas.
    $.clock.every(60_000, () => {
      void (async () => {
        const now = await $.clock.now()
        await update($, tickAtom, () => now)
        const reading = await read($, readingAtom)
        if (reading) {
          await addSnaps($, reading, reading, now)
          await recordClosed($, reading, null, now)
        }
        await refresh($)
      })()
    })

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const family = modelFamily(e.usage?.model)
    if (family) pending.add(family)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await ingest($, e.rateLimits)
    return next(e)
  })

  on('command.run', { command: 'ritmo' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Panel de ritmo de uso abierto.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await read($, tickAtom) // suscribe al tic de cada minuto
    const reading = await read($, readingAtom)
    const now = await $.clock.now()
    const paces = computePaces(reading, await read($, snapsAtom), now)
    const calib = await read($, calibAtom)
    const history = await read($, historyAtom)
    const family = (await read($, modelAtom)) || null
    const plan = planFor(paces, calib, family)
    const overall = weekPerFivePoint(calib)
    const fiveRatio = (family ? weekPerFivePoint(calib, family).ratio : null) ?? overall.ratio
    const models = Object.keys(calib.byModel)
      .map(m => ({ m, ratio: weekPerFivePoint(calib, m).ratio }))
      .filter((x): x is { m: string; ratio: number } => x.ratio !== null && x.ratio > 0)

    const cols = e.props.bodyColumns ?? 40
    const barW = Math.max(10, Math.min(40, cols - 2))
    const color = (p: Pace) =>
      p.status === 'sobrado' ? 'success' : p.status === 'en-ritmo' ? 'warning' : 'error'
    const sched = cfg.schedule
    const schedText =
      sched.start === 0 && sched.end === 24 ? '24 h' : `${sched.start}:00–${sched.end}:00`

    const w5 = wasteSummary(history, 'five_hour', 10)
    const w7 = wasteSummary(history, 'seven_day', 4)

    return (
      <Box flexDirection="column">
        {paces.length === 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>Sin lectura de límites todavía.</Text>
            <Text dimColor>Aparece tras la primera respuesta del modelo (requiere suscripción).</Text>
          </Box>
        )}
        {paces.map(p => {
          const isWeek = p.kind === 'seven_day'
          const s = p.slot
          const extra = s.budget - s.normal
          return (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold>
                {isWeek ? 'Límite semanal' : 'Límite 5 horas'}{' '}
                <Text color={color(p)}>
                  {STATUS_ICON[p.status]} {STATUS_TEXT[p.status]}
                </Text>
              </Text>
              <Text>
                <Text color={color(p)}>{bar(p.used, p.expected, barW)}</Text>
              </Text>
              <Text>
                Usado {pct(p.used)} · esperado {pct(p.expected)} · margen{' '}
                <Text color={color(p)}>{signed(p.margin)} pts</Text>
              </Text>
              <Text dimColor>
                Reinicia en {fmtDur(p.remH)} ({fmtClock(p.resetMs, isWeek)})
                {isWeek ? ` · ${fmtDur(p.remActiveH)} activas (horario ${schedText})` : ''}
              </Text>
              <Text>
                Ritmo necesario: {pct(p.needPerH)}/h{isWeek ? ' activa' : ''} (parejo {pct(p.idealPerH)}/h)
              </Text>
              <Text>
                Cupo {s.label}: {pct(s.budget)} (normal {pct(s.normal)}
                {Math.abs(extra) >= 0.1
                  ? `, ${signed(extra)} por lo ${extra > 0 ? 'no usado' : 'adelantado'} antes`
                  : ''}
                ) · llevas {pct(s.usedInSlot)} ·{' '}
                <Text color={s.left >= 0 ? 'success' : 'error'}>
                  {s.left >= 0 ? `te quedan ${pct(s.left)}` : `te pasaste ${pct(-s.left)}`}
                </Text>
              </Text>
              {isWeek && plan && (
                <Text>
                  1 ventana de 5h al 100% ≈ {pct(plan.perWindow)} semanal → te faltan{' '}
                  <Text bold>≈{plan.needed.toFixed(1)} ventanas</Text> (
                  {plan.afterCurrent.toFixed(1)} más si terminas la actual) · caben{' '}
                  <Text color={plan.available >= plan.needed ? 'success' : 'error'}>
                    {plan.available}
                  </Text>{' '}
                  en tu horario
                </Text>
              )}
              {isWeek && models.length > 0 && (
                <Text>
                  Por modelo:{' '}
                  {models
                    .map(({ m, ratio }) => `${MODEL_LABEL(m)} ≈${((100 - p.used) / (ratio * 100)).toFixed(1)}`)
                    .join(' · ')}{' '}
                  ventanas
                </Text>
              )}
              {isWeek && !plan && (
                <Text dimColor>
                  Calibrando equivalencia 5h↔semanal: {overall.seenFive.toFixed(0)}/10 pts del 5h observados
                </Text>
              )}
              {!isWeek && fiveRatio !== null && (
                <Text dimColor>
                  Lo que queda de esta ventana ({pct(100 - p.used)}) ≈ {pct((100 - p.used) * fiveRatio)} del
                  semanal
                </Text>
              )}
              {p.avgPerH !== null && (
                <Text dimColor>
                  Tu promedio: {pct(p.avgPerH)}/h →{' '}
                  {p.hitsAtMs !== null
                    ? `topas el 100% el ${fmtClock(p.hitsAtMs, isWeek)} (${fmtDur((p.resetMs - p.hitsAtMs) / 3_600_000)} antes del reset)`
                    : `terminarías en ~${pct(p.projected ?? p.used)}`}
                </Text>
              )}
            </Box>
          )
        })}
        <Text bold>Aprovechamiento</Text>
        {w5.avg === null && w7.avg === null ? (
          <Text dimColor>Se registra con qué % cierra cada ventana; aún no ha cerrado ninguna.</Text>
        ) : (
          <Box flexDirection="column">
            {w5.avg !== null && (
              <Text>
                Ventanas 5h (últimas {w5.finals.length}): promedio{' '}
                <Text color={w5.avg >= 85 ? 'success' : w5.avg >= 60 ? 'warning' : 'error'}>
                  {pct(w5.avg)}
                </Text>{' '}
                · {w5.finals.map(f => f.toFixed(0)).join(' ')}
              </Text>
            )}
            {w7.avg !== null && (
              <Text>
                Semanas (últimas {w7.finals.length}): promedio{' '}
                <Text color={w7.avg >= 90 ? 'success' : w7.avg >= 70 ? 'warning' : 'error'}>
                  {pct(w7.avg)}
                </Text>{' '}
                · {w7.finals.map(f => f.toFixed(0)).join(' ')}
              </Text>
            )}
          </Box>
        )}
        {reading && (
          <Text dimColor>
            Última lectura: {fmtClock(reading.observedAt, false)} · modelo {family ?? '—'} · sin uso de tokens
          </Text>
        )}
      </Box>
    )
  })
}

function bar(used: number, expected: number, width: number): string {
  const filled = Math.round((used / 100) * width)
  const mark = Math.min(width - 1, Math.round((expected / 100) * width))
  let s = ''
  for (let i = 0; i < width; i++) {
    s += i === mark ? '┃' : i < filled ? '█' : '░'
  }
  return s
}
