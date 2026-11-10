export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Reading = { limits: Limit[]; observedAt: number }
/** % usado al empezar el tramo actual (hora del 5h, día del semanal). */
export type Snap = { key: string; used: number; remH: number }

declare module 'claude-code' {
  interface PluginState {
    'ritmo-uso': {
      reading: Reading | null
      snaps: Snap[]
      tick: number
    }
  }
}
