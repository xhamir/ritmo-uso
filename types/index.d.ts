export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Reading = { limits: Limit[]; observedAt: number }
/** % usado al empezar el tramo actual (hora del 5h, día del semanal). */
export type Snap = { key: string; used: number; remH: number }

/** Puntos acumulados de 5h y semanal atribuidos a un modelo. */
export type ModelCalib = { five: number; week: number }
/** Última lectura usada para calcular el siguiente delta. */
export type CalibLast = { fiveReset: string; weekReset: string; five: number; week: number; at?: number }
/** Cuánto sube el semanal por cada punto del 5h, por familia de modelo. */
export type Calib = { byModel: Record<string, ModelCalib>; last: CalibLast | null }

/** Con qué % cerró una ventana (5h o semanal). */
export type Closed = { kind: string; reset: string; final: number }

declare module 'claude-code' {
  interface PluginState {
    'ritmo-uso': {
      reading: Reading | null
      snaps: Snap[]
      tick: number
      calib: Shaped<Calib>
      history: Closed[]
      model: string
    }
  }
}
