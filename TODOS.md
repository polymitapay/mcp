# TODOs — encontrados probando `wallet-mcp-server` real (post-deploy)

> Se van sumando durante las pruebas manuales. No se implementa nada de acá hasta que se diga explícitamente "vamos a resolver esto".

## Pendientes

1. **Registro de logs real de toda la cadena agente → herramienta → pago.** Pedido explícito del usuario: quiere trazabilidad completa y confiable de ese flujo (no solo `console.error` a stderr como hoy en `wallet-mcp-server`, ni solo lo que ya persiste `agent-rail` en `Payment`/`CallRecord`) — cruza los dos repos (`wallet-mcp-server` del lado del agente, `agent-rail` del lado del proxy/pago). A definir cuando se retome: qué se loguea exactamente, dónde queda (archivo, tabla nueva, servicio de logging), y con qué nivel de detalle por cada etapa (descubrimiento, pago, ejecución de la tool, resultado).

2. **Variables de entorno para controlar el gasto del agente.** Hoy `xrpl-payment-client.ts` tiene `.setSpendControls(false)` — sin ningún límite, el agente paga lo que el provider pida. Faltan como mínimo dos, que resuelven problemas distintos:
   - `POLYPAY_MAX_PER_CALL` — tope máximo que el agente acepta pagar en una sola llamada (protege contra un provider que pide de más, o un error de precio).
   - `POLYPAY_MAX_TOTAL` (o por sesión/por día, a definir) — tope acumulado, para que un agente que entra en loop llamando tools repetidas veces no vacíe la wallet — es un problema distinto al anterior, no lo resuelve un tope por llamada.
   - Pendiente de decidir: si el tope es en una sola unidad (ej. XRP) o tiene que ser consciente del asset elegido (ya resuelto el punto 1 original — ver Resuelto abajo) para no comparar peras con manzanas.

## Resuelto

- **(2026-08-27) El agente ya puede elegir método de pago (XRP vs RLUSD), y la trust line de RLUSD se abre sola.** Implementado en `xrpl-payment-client.ts` (`registerPolicy` + `onBeforePaymentCreation`) y `server.ts` (parámetro `asset` opcional en `polypay_call`). Al implementarlo se encontró y arregló un bug real en `agent-rail`: `PaymentRequirements.asset` mandaba el string humano `"RLUSD"` en vez del código de moneda XRPL válido (hex de 40 caracteres) — `ExactXrplScheme` usa ese campo literal para armar la transacción, así que cualquier intento de pagar en RLUSD fallaba al firmar. Arreglado en `consume-provider.usecase.ts` (`assetFromWireAsset` traduce el hex de vuelta a `'RLUSD'` para que el resto del dominio no se entere). Verificado con un test e2e real que liquida un pago en RLUSD contra testnet (`x402-consume.e2e-spec.ts`), usando una wallet fija fondeada a mano (RLUSD no tiene faucet scriptable).
