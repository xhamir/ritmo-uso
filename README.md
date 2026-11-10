# ritmo-uso

Mod de Claude Code que muestra el **ritmo de uso** de tus límites de suscripción (5 horas y semanal), para aprovecharlos al máximo sin topar antes de tiempo. Todo se calcula localmente: **no usa tokens**.

- **Barra de estado**: `🟢 5h 55%/60% (+5.0) · esta hora 18.5% libre · ↻2h 00m | 🟢 sem 30%/43% (+12.9) · hoy 17.5% libre · ↻4d 0h`
- **Panel `/ritmo`**: % usado vs. esperado, ritmo necesario (%/h y %/día) para llegar al 100% al reinicio, cupo de esta hora / de hoy (sube si antes usaste menos), y proyección a tu ritmo promedio.
- Indicadores: 🟢 sobrado · 🟡 en ritmo (±5 pts) · 🔴 adelantado (riesgo de topar) · ⛔ agotado.

Requiere una suscripción de Claude; los datos aparecen tras la primera respuesta del modelo en la sesión.

## Instalación

En el prompt de una sesión de Claude Code en la terminal:

```
/plugin install ritmo-uso --marketplace xhamir/ritmo-uso
```

Responde `y` para agregar el marketplace y elige el alcance (user) con Enter.

Desde una shell:

```
claude plugin install ritmo-uso --marketplace xhamir/ritmo-uso
```

En la app de escritorio: clic en **+** junto al cuadro del prompt → **Plugins** → **Add marketplace** con `xhamir/ritmo-uso` → **Add plugin**.
