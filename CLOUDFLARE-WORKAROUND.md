# Acceso al portal protegido por Cloudflare

## Propósito

El portal público de jurisprudencia puede responder a una consulta HTTP con una
página de verificación de Cloudflare en lugar del HTML del buscador. Cuando eso
ocurre, el MVP no puede tratar la respuesta como un resultado de jurisprudencia:
la identifica como `CHALLENGE_REQUIRED` y cambia al acceso mediante un navegador
Chromium normal.

Este documento describe el procedimiento técnico incorporado en el MCP y la
aplicación. No es un bypass de Cloudflare ni intenta evadir sus controles: la
verificación se completa en una sesión de navegador autorizada y el MCP solo
reutiliza esa sesión para leer el resultado público.

## Diseño del flujo

```text
Consulta one-shot de la web
          |
          v
        MCP
          |
          +-- HTTP directo --------------------+
          |                                    |
          |  HTML válido: parsear resultado    |
          |  Challenge: cambiar a navegador   |
          v                                    |
  Chromium con perfil temporal                 |
          |                                    |
          +-- sesión gráfica del host ---------+
          |   o Chromium dentro de Xvfb
          |
          +-- CDP /json/list + WebSocket
          |
          +-- navegar al buscador
          +-- esperar que termine el desafío
          +-- leer HTML con JavaScript
          +-- capturar el PDF desde la respuesta de red
```

El MCP usa tres herramientas de acceso al portal:

- `search_jurisprudencia`: busca y devuelve metadatos, IDs y URLs de PDF.
- `get_jurisprudencia_detail`: recupera el detalle HTML de un fallo.
- `get_jurisprudencia_pdf_text`: captura el PDF público desde la red del
  navegador y extrae su texto localmente con `pdftotext`.

La herramienta `diagnose_jurisprudencia_access` informa si el acceso HTTP está
recibiendo un desafío y si el endpoint CDP está disponible.

## Procedimiento recomendado: Chrome del host + CDP

Este es el camino más estable para un desafío que requiere una sesión gráfica.
El navegador se inicia manualmente con un perfil separado del perfil personal y
con el puerto CDP escuchando únicamente en `127.0.0.1`.

### 1. Preparar configuración

```bash
cp .env.example .env
```

En `.env`:

```dotenv
JURIS_ACCESS_MODE=browser
JURIS_CDP_URL=http://127.0.0.1:9222
JURIS_CHALLENGE_TIMEOUT_MS=60000
```

### 2. Iniciar Chrome manualmente

Desde una sesión gráfica del host:

```bash
DISPLAY=:0 ./scripts/start-host-chrome.sh
```

El script:

1. localiza `google-chrome` o `chromium`;
2. usa `/tmp/mvp-jurisprudencia-chrome-profile` por defecto, sin mezclar
   cookies con el perfil personal;
3. inicia el navegador sin reinicio automático;
4. habilita CDP en `127.0.0.1:9222`;
5. deja una pestaña `about:blank` disponible para el MCP.

Abrir manualmente el buscador en esa ventana si aparece la verificación y
completarla de forma interactiva. Una vez que el portal muestra su contenido
normal, la aplicación puede reutilizar la misma pestaña y sus cookies de sesión.

### 3. Iniciar la aplicación

```bash
docker compose up -d --build
```

El Compose usa `network_mode: host`, por lo que el contenedor puede alcanzar
`127.0.0.1:9222` del mismo host. El servicio tiene `restart: "no"`; tanto Chrome
como la aplicación deben arrancarse manualmente.

### 4. Comprobar el acceso

```bash
curl http://localhost:3000/api/diagnose
```

El estado esperado cuando Chrome está disponible es:

```json
{
  "cdpConfigured": true,
  "cdpReachable": true,
  "recommendedAccessMode": "cdp"
}
```

Después se puede ejecutar una consulta desde la interfaz web o mediante
`POST /api/query`.

## Alternativa contenida: Chromium + Xvfb

Si no se configura `JURIS_CDP_URL`, el MCP puede iniciar Chromium dentro del
contenedor. Cuando no existe `DISPLAY` y `JURIS_USE_XVFB=1`, crea una pantalla
virtual con Xvfb. El modo se selecciona así:

```dotenv
JURIS_ACCESS_MODE=auto
JURIS_HEADLESS=0
JURIS_USE_XVFB=1
```

`JURIS_HEADLESS=0` es intencional: una sesión no-headless conserva mejor el
comportamiento esperado por sitios que requieren JavaScript, cookies y una
sesión de navegador completa. Este camino puede no superar todos los desafíos;
si Cloudflare requiere una interacción adicional, se recomienda el navegador
gráfico del host.

El contenedor instala `chromium-sandbox` y el Compose desactiva únicamente el
seccomp restrictivo que impedía crear los namespaces requeridos por Chromium.
No se usa `--no-sandbox`.

## Qué hace el MCP cuando navega

1. `directFetch` intenta HTTP directo en modo `auto`.
2. La respuesta se inspecciona buscando la cabecera `cf-mitigated` y señales
   como `Just a moment`, `Security Check Required` o `Verificando la conexión`.
3. Si hay desafío, el MCP inicia o conecta Chromium.
4. La sesión navega a la URL original y espera hasta
   `JURIS_CHALLENGE_TIMEOUT_MS`.
5. Solo continúa cuando el documento está completo y ya no muestra el desafío.
6. Para los PDFs, escucha la respuesta de red con `Fetch`/`Network` y obtiene el
   cuerpo binario, sin depender de una descarga directa que perdería las
   cookies de la sesión.

El MCP no resuelve CAPTCHAs, no modifica tokens de Cloudflare, no falsifica
encabezados de navegador y no intenta saltar controles de acceso. Si la
verificación no termina, devuelve el estado visible de la página para facilitar
el diagnóstico.

## Diagnóstico de errores habituales

### `ECONNREFUSED 127.0.0.1:9222`

Chrome CDP no está escuchando o el contenedor no fue iniciado con la misma
configuración. Comprobar:

```bash
curl http://127.0.0.1:9222/json/version
```

Si falla, ejecutar nuevamente `DISPLAY=:0 ./scripts/start-host-chrome.sh` y
confirmar que `/tmp/mvp-jurisprudencia-chrome.log` no informa un error de
Chrome.

### `No usable sandbox`

Es un problema de ejecución de Chromium dentro del contenedor. La imagen ya
instala `chromium-sandbox` y el Compose incluye `security_opt: seccomp=unconfined`.
Reconstruir la imagen con:

```bash
docker compose up -d --build
```

No agregar `--no-sandbox` salvo que se evalúe conscientemente el impacto de
seguridad en un entorno descartable.

### `Cloudflare no completó el desafío dentro del tiempo permitido`

La sesión no llegó a contenido normal dentro del plazo. Revisar el estado de la
pestaña Chrome, completar cualquier interacción pendiente y aumentar localmente
el valor si la red necesita más tiempo:

```dotenv
JURIS_CHALLENGE_TIMEOUT_MS=120000
```

También puede ocurrir que la política del portal no permita ese origen, IP o
automatización. En tal caso el MCP debe reportar el bloqueo; no hay garantía de
que Xvfb o un navegador externo resuelvan todos los desafíos.

## Consideraciones de seguridad y operación

- El perfil temporal puede contener cookies de la sesión; no debe publicarse ni
  incorporarse al repositorio.
- CDP no debe exponerse a `0.0.0.0` ni publicarse mediante un proxy.
- `.env` puede contener configuración local o credenciales de proveedores de
  IA; permanece fuera del repositorio.
- Las consultas y los documentos recuperados se procesan localmente antes de
  enviarse al proveedor de síntesis configurado.
- El contenido jurídico debe verificarse contra la fuente oficial y no
  constituye asesoramiento legal.
