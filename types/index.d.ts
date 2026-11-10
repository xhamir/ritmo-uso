export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Reading = { limits: Limit[]; observedAt: number }
/** % usado al empezar el tramo actual (hora del 5h, día del semanal). */
export type Snap = { key: string; used: number; remH: number }
/** Ventana de 5h que se está observando para calibrar: valores al inicio y últimos. */
export type CalibWindow = {
  fiveReset: string
  weekReset: string
  five0: number
  week0: number
  fiveLast: number
  weekLast: number
}
/** Cuánto sube el semanal por cada punto del límite de 5h, acumulado entre ventanas. */
export type Calib = { sumFive: number; sumWeek: number; cur: CalibWindow | null }

declare module 'claude-code' {
  interface PluginState {
    'ritmo-uso': {
      reading: Reading | null
      snaps: Snap[]
      tick: number
      calib: Calib
    }
  }
}
