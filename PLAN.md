# Wallet MCP server — para que un usuario común lo instale en su agente

**Nota de alcance**: este documento es una guía de arquitectura e implementación. **El usuario escribe el código** — Claude ayuda con diseño, dudas puntuales, y revisión de código a medida que se escribe. No es un plan que Claude vaya a ejecutar solo.

## Contexto

Hoy, para que un agente de IA consuma un provider de PolyPay pagando automáticamente, quien construye ese agente tiene que programar la integración a mano (usando `@x402/mcp` o similar). Eso excluye a cualquier "usuario común" que solo quiere pegar un bloque de configuración en Claude Desktop (o cualquier cliente MCP) y que su agente ya pueda pagar y usar el catálogo de PolyPay. Esa es exactamente la fricción que **antes de soltar el MVP** hay que resolver — sin esto, la plataforma solo sirve a desarrolladores, no al usuario final que fue parte de la visión original.

Inspiración explícita (ya investigada, ver `roadmap.md` Fase 5 / memoria `reference_piprail_competitor`): `@piprail/mcp` resuelve el mismo problema — un MCP server que el usuario instala vía `npx`, le da su wallet por variable de entorno, y listo. Punto de fricción que ni ellos resuelven, y que tampoco vamos a resolver acá (es inherente a un diseño no-custodial): el usuario igual necesita conseguir y pegar una llave privada real.

Hallazgo clave de la exploración: **`@x402/mcp` (ya instalado en `agent-rail`, `^2.22.0`, no usado en ningún lado todavía) trae exactamente el mecanismo de auto-pago que hace falta** — `x402MCPClient` envuelve un `Client` de MCP normal, y su `callTool()` detecta un 402, arma el pago con el `x402Client` que le pases, y reintenta solo. No hay que reinventar la lógica de pago, solo empaquetarla como un MCP server instalable.

## Diseño

### Arquitectura (vista general)

```
Agente del usuario (Claude Desktop, etc.)
        │  MCP sobre stdio (spawneado localmente)
        ▼
wallet-mcp-server (paquete nuevo, corre en la máquina del usuario)
   - tiene la wallet seed del usuario (env var)
   - al arrancar: pide el catálogo público a agent-rail
   - por cada provider del catálogo: abre un x402MCPClient
     (auto-paga) contra agent-rail
   - expone TODAS las tools descubiertas, con nombres
     namespaced, en su propio server MCP (stdio)
        │  MCP sobre HTTP, por provider (x402MCPClient
        │  auto-paga con la wallet del usuario)
        ▼
agent-rail: POST /mcp/:providerId  (YA EXISTE — mcp-proxy.controller.ts)
        │  MCP real, sin pago (McpProviderGateway ya lo resuelve)
        ▼
MCP real de un tercero (el provider registrado en PolyPay)
```

El wallet-mcp-server nunca habla directo con el MCP del provider — siempre pasa por `POST /mcp/:providerId`, que ya es nuestro proxy con cobro. Eso mantiene la comisión y el pricing centralizados, ningún camino nuevo los evita.

### Fase 1 — Backend (agent-rail): catálogo público

Hoy no existe ninguna forma de listar providers sin auth: `GET /v1/providers` (`provider-registration.controller.ts`) es del dueño autenticado, `GET /v1/admin/providers` (`admin-provider.controller.ts`) es admin-only. El wallet-mcp-server necesita descubrir el catálogo **sin cuenta de PolyPay** — es lo único nuevo del lado del backend.

- Nuevo `GET /v1/catalog` (público, sin guard), en un controller nuevo (más limpio que agregarlo a `provider-registration.controller.ts`, que está guardado a nivel de clase entera).
- Filtra por `status: 'APPROVED'` y por `network` (query param `?network=testnet|mainnet`, default `mainnet`) — mismo principio de "cada red es un ecosistema separado" ya usado en todo el proyecto.
- Payload por provider: `id`, `name` (o `mcpUrl` como fallback si no tiene nombre — mismo criterio que ya usa el resto del dashboard), y `tools: [{ toolName, pricePerCall, pricePerCallRlusd }]`. **No** exponer `mcpUrl` ni `receivingWalletAddress` — el wallet-mcp-server solo necesita el `id` para llamar a `POST /mcp/:id`, nunca al MCP real directamente.
- Reutiliza `ProviderRepositoryPort.findAll()` (ya existe, usado igual en `admin-provider.controller.ts`) — no hace falta ningún método nuevo en el repo.

### Fase 2 — El paquete nuevo: `wallet-mcp-server`

Ubicación: `AGENTRAIL/wallet-mcp-server/` (este mismo directorio — repo hermano de `agent-rail`/`front-agent-rail`/`test-mcp-provider`/`x402-spike`, mismo patrón que ya existe). Nombre de paquete sugerido para cuando se publique: `@polymitapay/mcp` (mismo naming que `@piprail/mcp`).

**Dependencias — atención, esto es lo más no-obvio de toda la investigación**: `agent-rail` usa DOS generaciones distintas de paquetes MCP a la vez — la vieja (`@modelcontextprotocol/sdk` v1.30, un solo paquete monolítico) y la nueva (`@modelcontextprotocol/{server,client,node}` v2.0, separados). `@x402/mcp` (de donde sale `x402MCPClient`) está tipado contra la clase `Client` de la vieja (`@modelcontextprotocol/sdk/client/index.js`), **no** contra la nueva. Además, la nueva generación (`@modelcontextprotocol/node` v2) solo trae transporte HTTP (`NodeStreamableHTTPServerTransport`) — **no tiene transporte stdio**, que es justo lo que hace falta para un MCP server local que un cliente como Claude Desktop spawnea. Confirmado (revisando los `.d.ts` reales instalados): `@modelcontextprotocol/sdk` v1.30 sí trae `server/stdio.js` (`StdioServerTransport`) y `client/stdio.js`/`client/streamableHttp.js`. Conclusión: **este paquete nuevo usa únicamente `@modelcontextprotocol/sdk` v1.x** (no los paquetes v2 split que usa el resto de `agent-rail`), más `@x402/core`, `@x402/xrpl`, `@x402/mcp`, y `xrpl`.

**Lado que habla con el agente del usuario (servidor, stdio)**:
- `Server` de bajo nivel de `@modelcontextprotocol/sdk/server/index.js` (mismo patrón exacto que ya usa `mcp-proxy.controller.ts` — `setRequestHandler('tools/list', ...)` / `setRequestHandler('tools/call', ...)`, no el `McpServer` de alto nivel con Zod, porque las tools son dinámicas/descubiertas en runtime, no conocidas de antemano).
- Transporte: `StdioServerTransport` de `@modelcontextprotocol/sdk/server/stdio.js`.
- **Gotcha real a tener en cuenta**: con stdio, `stdout` es el canal del protocolo JSON-RPC — cualquier `console.log` lo corrompe. Todo log/debug tiene que ir a `console.error` (stderr).

**Lado que habla con agent-rail (cliente, HTTP, uno por provider)**:
- Al arrancar: `fetch(`${POLYPAY_API_URL}/v1/catalog?network=${POLYPAY_NETWORK}`)` (Fase 1).
- Por cada provider del catálogo: `Client` + `StreamableHTTPClientTransport` (ambos de `@modelcontextprotocol/sdk/client/...`) apuntando a `${POLYPAY_API_URL}/mcp/${providerId}`, envuelto en `x402MCPClient` (de `@x402/mcp`) con el `x402Client` de pago (ver abajo). Guardar en un `Map<providerId, x402MCPClient>`.
- Payment client (una sola vez, reusado para todos los providers):
  ```ts
  import { Wallet } from 'xrpl';
  import { createXrplWalletSigner } from '@x402/xrpl';
  import { ExactXrplScheme } from '@x402/xrpl/exact/client';
  import { x402Client } from '@x402/core/client';

  const wallet = Wallet.fromSeed(process.env.POLYPAY_WALLET_SEED!);
  const signer = createXrplWalletSigner(wallet);
  const paymentClient = new x402Client().register('xrpl:*', new ExactXrplScheme(signer));
  ```
  (Patrón idéntico al que ya usan los tests e2e de `agent-rail`, ej. `test/x402-consume.e2e-spec.ts`.)

**Agregación de tools**:
- Por cada `x402MCPClient` conectado, llamar `.listTools()` (ya trae el schema real, reenviado tal cual por nuestro proxy) y namespacear cada nombre como `${providerName-saneado}_${providerId-corto}__${toolName}`. El sufijo del id (no solo el nombre) es necesario porque el nombre **no** es único — se encontró en la práctica que dos providers reales sin `name` configurado caían al mismo fallback (`mcpUrl`) y colisionaban en el mismo namespace, pisándose uno a otro en silencio en el registro (un provider entero desaparecía sin ningún error ni aviso).
- Guardar un mapa `toolName-namespaced → { providerId, providerName, realToolName, description, pricePerCall, pricePerCallRlusd, x402Mcp }` — la `description` sale del schema MCP real de la tool (siempre presente en cualquier tool MCP válida), el precio sale de cruzar contra `provider.tools` del catálogo (`null` si esa tool puntual no está priceada, corre gratis).
- Si un provider falla al conectar/listar (su MCP real está caído) — loguearlo a stderr y seguir con el resto, no tirar abajo todo el proceso.

**Diseño revisado (2026-08-25): NO se expone una tool por cada tool real descubierta.** El diseño original de este documento asumía que `tools/list` del server de salida iba a listar cada tool namespaced directamente. Se cambió tras razonar el caso de un catálogo grande: paginar `tools/list` (el protocolo MCP lo soporta, `cursor`/`nextCursor`) resuelve el tamaño de la respuesta, pero no resuelve que un cliente MCP arma su inventario completo de tools ANTES de conversar, y ese inventario completo — con su schema — viaja en el contexto del LLM en cada turno. Un catálogo de cientos de tools sería caro en tokens y degradaría qué tan bien el agente elige, sin importar cómo se transporte por el wire.

En vez de eso, el server de salida expone **siempre exactamente dos tools fijas**, sin importar cuántos providers haya:
- **`polypay_search({ query })`** — busca sobre el registro agregado (nombre + descripción + provider) con `minisearch` (BM25 local, sin red, sin dependencias externas — no hace falta exacta, alcanza con coincidencia por palabras clave con ranking). Devuelve hasta 20 candidatos (deliberadamente generoso, no un tope chico tipo "3" — los resultados son livianos: nombre + descripción + precio, no el schema completo) con `{ tool, provider, description, pricePerCall, pricePerCallRlusd }`.
- **`polypay_call({ tool, arguments })`** — resuelve `tool` (el id namespaced devuelto por `polypay_search`) contra el registro, llama `x402MCPClient.callTool(realToolName, arguments)` de esa entrada — el auto-pago lo sigue manejando `x402MCPClient` solo — y traduce el `x402MCPToolCallResult` (que trae `paymentMade`/`paymentResponse`, campos que el schema `CallToolResult` no conoce) a `{ content, isError, _meta: {'x402/payment-made', 'x402/payment-response'} }`.

Pendiente real, no resuelto: si dos providers ofrecen tools casi idénticas, el ranking de `minisearch` puede favorecer sistemáticamente al mismo siempre — con 20 resultados y 2 providers hoy no se nota, pero con densidad real de providers compitiendo, un provider legítimo podría no aparecer nunca en el top-20. Diversificación real (garantizar exposición pareja entre providers competidores) queda anotada para cuando haya catálogo suficiente para siquiera poder probarlo.

**Configuración (variables de entorno)**:
- `POLYPAY_WALLET_SEED` (obligatoria) — seed XRPL clásica.
- `POLYPAY_API_URL` (default: la URL de producción de agent-rail).
- `POLYPAY_NETWORK` (default `testnet` para el release inicial — recomendado empezar recomendando testnet en la documentación, mainnet como uso avanzado explícito).
- `POLYPAY_PROVIDERS` (opcional, lista de ids separados por coma) — si se define, filtra el catálogo a solo esos providers en vez de exponer el marketplace completo. Sin esto, por default se expone TODO el catálogo aprobado de esa red — mejor default para "usuario común que no conoce IDs de provider", con el filtro como escape hatch para quien sí sabe lo que quiere. **Todavía no implementado** (2026-08-25) — documentado acá desde la investigación original, pendiente de construir.

**Mejora futura anotada (2026-08-25), no ahora**: `POLYPAY_PROVIDERS` con UUIDs crudos es incómodo de tipear a mano. Dos caminos posibles cuando se retome:
  - **Slug real en backend** — campo nuevo en `Provider` (DB, migración, slugificación al registrar, manejo de colisiones, expuesto en `GET /v1/catalog`). La solución "correcta" a largo plazo, pero scope de backend real para una feature que hoy ni está construida.
  - **Slug calculado al vuelo, sin tocar el backend** — dejar que el filtro acepte también `provider.name` (o el mismo saneado que ya usa `toNamespace()` en `tool-registry.ts`), sin garantía de unicidad (si dos providers comparten nombre, matchea a ambos).
  Se decidió no resolverlo ahora — evaluar cuando haya evidencia real de que la gente lo necesita (volumen de providers, confusión real), no antes.

### Fase 3 — Empaquetado y docs de instalación (completa, 2026-08-25)

- `package.json`: `bin: { "polymitapay-mcp": "./dist/index.js" }`, shebang `#!/usr/bin/env node` en el entrypoint, para que funcione con `npx -y @polymitapay/mcp` sin instalación previa.
- Documentar el bloque de config exacto para pegar en un cliente MCP (Claude Desktop u otro), algo así:
  ```json
  {
    "mcpServers": {
      "polypay": {
        "command": "npx",
        "args": ["-y", "@polymitapay/mcp"],
        "env": {
          "POLYPAY_WALLET_SEED": "s...",
          "POLYPAY_NETWORK": "testnet"
        }
      }
    }
  }
  ```
- Ser explícito en la doc sobre el riesgo: la seed queda en texto plano en un archivo de config local — mismo trade-off que `@piprail/mcp`, no hay forma de evitarlo con una wallet no-custodial. Recomendar wallets de testnet / montos chicos para probar.

Hecho: shebang agregado, `npm run build` verificado (compila, preserva el shebang, `node dist/index.js` corre y sirve el loop completo real por stdio, tanto una tool paga como una gratis). `README.md` reescrito con el bloque de instalación, tabla de env vars, y la advertencia de seguridad. `.env.example` agregado (no se publica, `files` en `package.json` no lo incluye) para documentar las variables sin exponer la seed real. `POLYPAY_API_URL` hoy defaultea a `localhost:3000` porque agent-rail todavía no tiene URL de producción pública — pendiente actualizar el default cuando eso exista.

## Verificación

Dado que el código lo escribe el usuario, la verificación es manual (no hay suite e2e nueva que Claude vaya a escribir para este paquete):
1. Levantar `agent-rail` local + `test-mcp-provider`, tener al menos un provider `APPROVED` con una tool con precio, en testnet.
2. Correr el nuevo paquete localmente (`tsx src/index.ts` o `node dist/index.js`) con una wallet de testnet fondeada real en `POLYPAY_WALLET_SEED`.
3. Conectarle un cliente MCP de prueba por stdio (puede ser un script chico con `StdioClientTransport` del SDK, o directo un cliente MCP real como Claude Desktop apuntando al binario local) — confirmar `tools/list` trae exactamente `polypay_search` y `polypay_call` (nunca las tools reales directo), que `polypay_search` devuelve candidatos relevantes con precio, y que `polypay_call` sobre uno de ellos ejecuta el pago real on-chain (verificar balance de la wallet del usuario bajó, y el resultado real de la tool vuelve) sin que el usuario tuviera que escribir ningún código de pago. Validado end-to-end (2026-08-25) con un cliente `StdioClientTransport` real spawneando el server.
4. Confirmar que nada se imprime a stdout salvo el protocolo JSON-RPC (cualquier log de más rompe el cliente).

## Orden de trabajo sugerido

1. Fase 1 (backend) primero — es chica, autocontenida, y sin ella no hay nada que descubrir del lado del paquete nuevo.
2. Fase 2, en este orden interno: (a) armar el `x402Client`/signer con una wallet de testnet ya fondeada a mano, probarlo contra UN SOLO provider hardcodeado (sin catálogo todavía) para validar que el auto-pago funciona; (b) recién ahí agregar el fetch del catálogo y la agregación multi-provider; (c) por último el servidor stdio de salida.
3. Fase 3 al final, una vez que el loop completo funciona local.
