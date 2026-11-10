import { expect, test } from 'claude-code/testing'

import { EMPTY_CALIB, pace, slotKey, updateCalib, weekPerFivePoint, windowsPlan } from '../hooks/pace'

const r2 = (n: number | null | undefined) => (n == null ? n : Math.round(n * 100) / 100)

const H = 3_600_000
const NOW = Date.parse('2026-11-10T12:00:00Z')

test('5h: 3h transcurridas con 55% usado va sobrado', async () => {
  // Reinicia en 2h → transcurrido 3h de 5 → esperado 60%.
  const limit = { kind: 'five_hour', percentUsed: 55, resetsAt: new Date(NOW + 2 * H).toISOString() }
  const p = pace(limit, NOW, undefined)!
  expect(Math.round(p.expected)).toBe(60)
  expect(Math.round(p.margin)).toBe(5)
  expect(p.status).toBe('sobrado')
  expect(p.needPerH).toBe(22.5) // 45% en 2h
  expect(p.idealPerH).toBe(20)
})

test('semanal: el cupo de hoy sube si ayer no se usó', async () => {
  // Quedan 4 días, llevas 30% → normal 14.3%/día, hoy te tocan 70/4 = 17.5%.
  const limit = { kind: 'seven_day', percentUsed: 30, resetsAt: new Date(NOW + 96 * H).toISOString() }
  const key = slotKey('seven_day', limit, NOW)
  const p = pace(limit, NOW, { key, used: 30, remH: 96 })!
  expect(p.status).toBe('sobrado') // esperado 42.9%
  expect(p.slot.budget).toBe(17.5)
  expect(p.slot.left).toBe(17.5)
  expect(p.slot.normal > 14.28 && p.slot.normal < 14.29).toBe(true)
})

test('adelantado y proyección de tope', async () => {
  // 1h de 5 transcurrida con 50% → promedio 50%/h, topas en 1h.
  const limit = { kind: 'five_hour', percentUsed: 50, resetsAt: new Date(NOW + 4 * H).toISOString() }
  const p = pace(limit, NOW, undefined)!
  expect(p.status).toBe('adelantado')
  expect(p.hitsLimitInH).toBe(1)
})

test('el panel muestra ambos límites', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e) => {
    if (e.key !== 'reading') return { value: { value: undefined, version: 0 } }
    return {
      value: {
        value: {
          observedAt: NOW,
          limits: [
            { kind: 'five_hour', percentUsed: 55, resetsAt: new Date(NOW + 2 * H).toISOString() },
            { kind: 'seven_day', percentUsed: 30, resetsAt: new Date(NOW + 96 * H).toISOString() },
          ],
        },
        version: 1,
      },
    }
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
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    expect((await ui.find({ type: 'Text', text: /Límite 5 horas/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Ritmo necesario: 22.5%\/h/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Límite semanal/ })) !== undefined).toBe(true)
    await ui.unmount()
  }
})

test('calibración: cuántas ventanas de 5h faltan para la semana', async () => {
  const r5 = new Date(NOW + 2 * H).toISOString()
  const r7 = new Date(NOW + 96 * H).toISOString()
  let c = updateCalib(EMPTY_CALIB, { kind: 'five_hour', percentUsed: 0, resetsAt: r5 }, { kind: 'seven_day', percentUsed: 10, resetsAt: r7 })
  expect(weekPerFivePoint(c).ratio).toBe(null)
  // 5h sube 40 pts mientras el semanal sube 6 → 1 ventana = 15% semanal.
  c = updateCalib(c, { kind: 'five_hour', percentUsed: 40, resetsAt: r5 }, { kind: 'seven_day', percentUsed: 16, resetsAt: r7 })
  expect(r2(weekPerFivePoint(c).ratio)).toBe(0.15)
  const five = pace({ kind: 'five_hour', percentUsed: 40, resetsAt: r5 }, NOW, undefined)!
  const week = pace({ kind: 'seven_day', percentUsed: 16, resetsAt: r7 }, NOW, undefined)!
  const plan = windowsPlan(five, week, 0.15)!
  expect(r2(plan.perWindow)).toBe(15)
  expect(r2(plan.needed)).toBe(5.6) // 84 / 15
  expect(r2(plan.afterCurrent)).toBe(5) // (84 - 60*0.15) / 15
  expect(plan.available).toBe(19) // 1 actual + floor(94/5)
  // Nueva ventana de 5h: lo anterior queda acumulado.
  const r5b = new Date(NOW + 7 * H).toISOString()
  c = updateCalib(c, { kind: 'five_hour', percentUsed: 0, resetsAt: r5b }, { kind: 'seven_day', percentUsed: 16, resetsAt: r7 })
  expect(c.sumFive).toBe(40)
  expect(r2(weekPerFivePoint(c).ratio)).toBe(0.15)
})
