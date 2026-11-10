import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Calib, Limit, Reading, Snap } from '../types'
import {
  EMPTY_CALIB,
  STATUS_ICON,
  STATUS_TEXT,
  fmtClock,
  fmtDur,
  isKind,
  pace,
  pct,
  signed,
  slotKey,
  statusLine,
  updateCalib,
  weekPerFivePoint,
  windowsPlan,
} from './pace'
import type { Pace, WindowsPlan } from './pace'

const PANE = 'ritmo-uso'
const TITLE = 'Ritmo de uso'

const readingAtom = atom({ plugin: 'ritmo-uso', key: 'reading' } as const, null)
const snapsAtom = atom({ plugin: 'ritmo-uso', key: 'snaps' } as const, [])
const tickAtom = atom({ plugin: 'ritmo-uso', key: 'tick' } as const, 0)
const calibAtom = atom({ plugin: 'ritmo-uso', key: 'calib' } as const, EMPTY_CALIB)

function planFor(paces: Pace[], calib: Calib): WindowsPlan | null {
  const week = paces.find(p => p.kind === 'seven_day')
  const { ratio } = weekPerFivePoint(calib)
  if (!week || ratio === null) return null
  return windowsPlan(paces.find(p => p.kind === 'five_hour'), week, ratio)
}

type Api = EngineInterface

function computePaces(reading: Reading | null, snaps: Snap[], now: number): Pace[] {
  if (!reading) return []
  const out: Pace[] = []
  for (const limit of reading.limits) {
    if (!isKind(limit.kind)) continue
    const key = slotKey(limit.kind, limit, now)
    const p = pace(limit, now, snaps.find(s => s.key === key))
    if (p && p.remH > 0) out.push(p)
  }
  // 5h primero, luego semanal.
  return out.sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : 0))
}

/** Guarda el % de inicio de cada tramo (hora / día) la primera vez que se ve. */
async function ensureSnaps($: Api, reading: Reading, now: number) {
  const current = await read($, snapsAtom)
  const fresh: Snap[] = []
  for (const limit of reading.limits) {
    if (!isKind(limit.kind) || !limit.resetsAt) continue
    const key = slotKey(limit.kind, limit, now)
    if (current.some(s => s.key === key)) continue
    const remH = Math.max(0, (Date.parse(limit.resetsAt) - now) / 3_600_000)
    fresh.push({ key, used: limit.percentUsed, remH })
  }
  if (fresh.length === 0) return
  const next = [...current, ...fresh].slice(-20)
  await update($, snapsAtom, () => next)
  await $.store.set('snaps', next)
}

async function refreshStatus($: Api) {
  const now = await $.clock.now()
  const paces = computePaces(await read($, readingAtom), await read($, snapsAtom), now)
  const plan = planFor(paces, await read($, calibAtom))
  $.ui.status(paces.length ? statusLine(paces, plan) : undefined)
}

async function ingest($: Api, limits: Limit[]) {
  const relevant = limits.filter(l => isKind(l.kind))
  if (relevant.length === 0) return
  const now = await $.clock.now()
  const reading: Reading = {
    limits: relevant.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    observedAt: now,
  }
  await update($, readingAtom, () => reading)
  await $.store.set('reading', reading)
  await ensureSnaps($, reading, now)
  const five = relevant.find(l => l.kind === 'five_hour')
  const week = relevant.find(l => l.kind === 'seven_day')
  if (five && week) {
    const calib = updateCalib(await read($, calibAtom), five, week)
    await update($, calibAtom, () => calib)
    await $.store.set('calib', calib)
  }
  await refreshStatus($)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    // Últimos valores conocidos (de otra sesión) para mostrar algo al instante.
    const stored = (await $.store.get('reading')) as Reading | undefined
    const storedSnaps = (await $.store.get('snaps')) as Snap[] | undefined
    if (Array.isArray(storedSnaps)) await update($, snapsAtom, () => storedSnaps)
    if (stored && Array.isArray(stored.limits)) await update($, readingAtom, () => stored)
    const storedCalib = (await $.store.get('calib')) as Calib | undefined
    if (storedCalib && typeof storedCalib.sumFive === 'number') {
      await update($, calibAtom, () => storedCalib)
    }

    await $.command.register({
      name: 'ritmo',
      description: 'Abre el panel de ritmo de uso (límite 5h y semanal)',
    })

    const usage = await $.session.usage()
    if (usage.rateLimits.length) await ingest($, usage.rateLimits)
    else await refreshStatus($)

    // Cada minuto: el tiempo avanza aunque no haya respuestas nuevas.
    $.clock.every(60_000, () => {
      void (async () => {
        const now = await $.clock.now()
        await update($, tickAtom, () => now)
        const reading = await read($, readingAtom)
        if (reading) await ensureSnaps($, reading, now)
        await refreshStatus($)
      })()
    })

    return result
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
    const snaps = await read($, snapsAtom)
    const now = await $.clock.now()
    const paces = computePaces(reading, snaps, now)
    const calib = await read($, calibAtom)
    const { ratio, seenFive } = weekPerFivePoint(calib)
    const plan = planFor(paces, calib)

    if (paces.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Sin lectura de límites todavía.</Text>
          <Text dimColor>Aparece tras la primera respuesta del modelo (requiere suscripción).</Text>
        </Box>
      )
    }

    const cols = e.props.bodyColumns ?? 40
    const barW = Math.max(10, Math.min(40, cols - 2))
    const color = (p: Pace) =>
      p.status === 'sobrado' ? 'success' : p.status === 'en-ritmo' ? 'warning' : 'error'

    return (
      <Box flexDirection="column">
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
              </Text>
              <Text>
                Ritmo necesario: {pct(p.needPerH)}/h (parejo {pct(p.idealPerH)}/h)
                {isWeek ? ` · ${pct(p.needPerH * 24)}/día (parejo ${pct(p.idealPerH * 24)}/día)` : ''}
              </Text>
              <Text>
                Cupo {s.label}: {pct(s.budget)} (normal {pct(s.normal)}
                {Math.abs(extra) >= 0.1 ? `, ${signed(extra)} por lo ${extra > 0 ? 'no usado' : 'adelantado'} antes` : ''}
                ) · llevas {pct(s.usedInSlot)} ·{' '}
                <Text color={s.left >= 0 ? 'success' : 'error'}>
                  {s.left >= 0 ? `te quedan ${pct(s.left)}` : `te pasaste ${pct(-s.left)}`}
                </Text>
              </Text>
              {isWeek && plan && (
                <Text>
                  1 ventana de 5h al 100% ≈ {pct(plan.perWindow)} semanal → te faltan{' '}
                  <Text bold>≈{plan.needed.toFixed(1)} ventanas al 100%</Text> (
                  {plan.afterCurrent.toFixed(1)} más si terminas la actual) · caben{' '}
                  <Text color={plan.available >= plan.needed ? 'success' : 'error'}>
                    {plan.available}
                  </Text>{' '}
                  antes del reinicio
                </Text>
              )}
              {isWeek && !plan && (
                <Text dimColor>
                  Calibrando equivalencia 5h↔semanal: {seenFive.toFixed(0)}/10 pts del 5h observados
                </Text>
              )}
              {!isWeek && ratio !== null && (
                <Text dimColor>
                  Lo que queda de esta ventana ({pct(100 - p.used)}) ≈ {pct((100 - p.used) * ratio)} del semanal
                </Text>
              )}
              {p.avgPerH !== null && (
                <Text dimColor>
                  Tu promedio: {pct(p.avgPerH)}/h →{' '}
                  {p.hitsLimitInH !== null
                    ? `topas el 100% en ${fmtDur(p.hitsLimitInH)} (${fmtDur(p.remH - p.hitsLimitInH)} antes del reset)`
                    : `terminarías en ~${pct(p.projected ?? p.used)}`}
                </Text>
              )}
            </Box>
          )
        })}
        {reading && (
          <Text dimColor>Última lectura: {fmtClock(reading.observedAt, false)} · sin uso de tokens</Text>
        )}
      </Box>
    )
  })
}
