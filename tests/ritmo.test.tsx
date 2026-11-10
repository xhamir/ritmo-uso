import { expect, test } from 'claude-code/testing'

import {
  EMPTY_CALIB,
  activeHours,
  alertsFor,
  closedWindows,
  pace,
  slotKey,
  updateCalib,
  weekPerFivePoint,
  windowsPlan,
} from '../hooks/pace'

const H = 3_600_000
const NOW = Date.parse('2026-11-10T12:00:00Z')
const r2 = (n: number | null | undefined) => (n == null ? n : Math.round(n * 100) / 100)
const iso = (ms: number) => new Date(ms).toISOString()
const midnight = (ms: number) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const at = (day: number, hour: number) => midnight(NOW) + day * 24 * H + hour * H

test('5h: 3h transcurridas con 55% usado va sobrado', async () => {
  const p = pace({ kind: 'five_hour', percentUsed: 55, resetsAt: iso(NOW + 2 * H) }, NOW, undefined)!
  expect(Math.round(p.expected)).toBe(60)
  expect(p.status).toBe('sobrado')
  expect(p.needPerH).toBe(22.5)
  expect(p.idealPerH).toBe(20)
})

test('adelantado y hora en que se topa', async () => {
  // 1h de 5 con 50% → promedio 50%/h, topas en 1h.
  const p = pace({ kind: 'five_hour', percentUsed: 50, resetsAt: iso(NOW + 4 * H) }, NOW, undefined)!
  expect(p.status).toBe('adelantado')
  expect(Math.round(((p.hitsAtMs ?? 0) - NOW) / 60_000)).toBe(60)
})

test('horas activas: 9 a 24 son 15 h por día, y cruzando medianoche también', async () => {
  expect(r2(activeHours(at(0, 0), at(1, 0), { start: 9, end: 24 }))).toBe(15)
  expect(r2(activeHours(at(0, 0), at(1, 0), { start: 18, end: 2 }))).toBe(8)
  expect(r2(activeHours(at(0, 0), at(7, 0), { start: 0, end: 24 }))).toBe(168)
})

test('semanal con horario: el esperado no avanza mientras duermes', async () => {
  const sched = { start: 9, end: 24 }
  const limit = { kind: 'seven_day', percentUsed: 30, resetsAt: iso(at(4, 12)) }
  const a = pace(limit, at(1, 1), undefined, sched)!
  const b = pace(limit, at(1, 8), undefined, sched)!
  const c = pace(limit, at(1, 12), undefined, sched)!
  expect(r2(a.expected)).toBe(r2(b.expected))
  expect(c.expected > b.expected).toBe(true)
})

test('semanal: el cupo de hoy sube si ayer no se usó', async () => {
  const reset = NOW + 96 * H
  const limit = { kind: 'seven_day', percentUsed: 30, resetsAt: iso(reset) }
  const p = pace(limit, NOW, { key: slotKey('seven_day', limit, NOW), used: 30, remH: 96 })!
  const fromMidnightH = (reset - midnight(NOW)) / H
  expect(r2(p.slot.budget)).toBe(r2((70 * 24) / fromMidnightH))
  expect(p.slot.budget > p.slot.normal).toBe(true)
  expect(r2(p.slot.normal)).toBe(r2(100 / 7))
})

test('calibración por modelo: Opus y Sonnet por separado', async () => {
  const r5 = iso(NOW + 2 * H)
  const r7 = iso(NOW + 96 * H)
  const f = (n: number) => ({ kind: 'five_hour', percentUsed: n, resetsAt: r5 })
  const w = (n: number) => ({ kind: 'seven_day', percentUsed: n, resetsAt: r7 })
  let c = updateCalib(EMPTY_CALIB, f(0), w(10), 'opus')
  c = updateCalib(c, f(20), w(16), 'opus') // Opus: 20 pts 5h → 6 semanal
  c = updateCalib(c, f(40), w(18), 'sonnet') // Sonnet: 20 pts 5h → 2 semanal
  c = updateCalib(c, f(50), w(30), null) // mezcla de modelos: se descarta
  expect(r2(weekPerFivePoint(c, 'opus').ratio)).toBe(0.3)
  expect(r2(weekPerFivePoint(c, 'sonnet').ratio)).toBe(0.1)
  expect(r2(weekPerFivePoint(c).ratio)).toBe(0.2)

  const five = pace(f(40), NOW, undefined)!
  const week = pace(w(16), NOW, undefined)!
  const plan = windowsPlan(five, week, 0.15)!
  expect(r2(plan.perWindow)).toBe(15)
  expect(r2(plan.needed)).toBe(5.6)
  expect(r2(plan.afterCurrent)).toBe(5)
  expect(plan.available).toBe(19)
})

test('desperdicio: registra con qué % cerró la ventana', async () => {
  const prev = {
    observedAt: NOW,
    limits: [{ kind: 'five_hour', percentUsed: 72, resetsAt: iso(NOW - H) }],
  }
  const next = {
    observedAt: NOW,
    limits: [{ kind: 'five_hour', percentUsed: 3, resetsAt: iso(NOW + 4 * H) }],
  }
  const closed = closedWindows(prev, next, NOW, [])
  expect(closed.length).toBe(1)
  expect(closed[0]!.final).toBe(72)
  expect(closedWindows(prev, next, NOW, closed).length).toBe(0)
})

test('alerta: ventana por cerrar con mucho sin usar', async () => {
  const p = pace({ kind: 'five_hour', percentUsed: 40, resetsAt: iso(NOW + 0.5 * H) }, NOW, undefined)!
  const alerts = alertsFor([p], null, NOW)
  expect(alerts.some(a => a.key.startsWith('waste5'))).toBe(true)
})

test('el panel muestra ambos límites y el aprovechamiento', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e) => {
    if (e.key === 'reading') {
      return {
        value: {
          value: {
            observedAt: NOW,
            limits: [
              { kind: 'five_hour', percentUsed: 55, resetsAt: iso(NOW + 2 * H) },
              { kind: 'seven_day', percentUsed: 30, resetsAt: iso(NOW + 96 * H) },
            ],
          },
          version: 1,
        },
      }
    }
    if (e.key === 'history') {
      return { value: { value: [{ kind: 'five_hour', reset: 'x', final: 80 }], version: 1 } }
    }
    return { value: { value: undefined, version: 0 } }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'ritmo-uso',
      component: 'Pane',
      requestId: 'ritmo-uso',
      surface,
      props: {
        title: 'Ritmo de uso',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    expect((await ui.find({ type: 'Text', text: /Límite 5 horas/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Ritmo necesario: 22.5%\/h/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Límite semanal/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /horario 9:00–24:00/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Ventanas 5h \(últimas 1\)/ })) !== undefined).toBe(true)
    await ui.unmount()
  }
})

test('calibración: una lectura vieja (uso no visto) no se atribuye al modelo', async () => {
  const r5 = iso(NOW + 2 * H)
  const r7 = iso(NOW + 96 * H)
  const f = (n: number) => ({ kind: 'five_hour', percentUsed: n, resetsAt: r5 })
  const w = (n: number) => ({ kind: 'seven_day', percentUsed: n, resetsAt: r7 })
  let c = updateCalib(EMPTY_CALIB, f(0), w(10), 'opus', NOW)
  c = updateCalib(c, f(30), w(20), 'opus', NOW + 2 * H) // 2 h sin lecturas: se descarta
  expect(c.byModel.opus).toBe(undefined)
  c = updateCalib(c, f(45), w(23), 'opus', NOW + 2 * H + 5 * 60_000)
  expect(r2(weekPerFivePoint(c, 'opus').ratio)).toBe(0.2)
})
