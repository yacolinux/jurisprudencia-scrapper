# MCP de jurisprudencia de Corrientes

Servidor MCP determinista para consultar el portal público de jurisprudencia del Poder Judicial de Corrientes sin usar un agente de IA para navegar o interpretar la página. Usa los GET y endpoints HTML que expone el propio portal, pero dentro de una sesión Chromium gráfica para que Cloudflare pueda ejecutar su verificación automática.

## Por qué usa Chromium gráfico

Al investigar el sitio se observó:

- `curl` recibe `403`, `cf-mitigated: challenge` y la página `Security Check Required`.
- Chromium `--headless=new` queda en `Just a moment…`.
- Un navegador gráfico normal completa el desafío y muestra el portal.
- El buscador avanzado es `GET /jurisprudencia/fallos/fallosstj?filtros=1`.
- El detalle es HTML en `GET /jurisprudencia/fallos/detalle_ajax/{id}`.
- Los resultados exponen un ID numérico para detalle y un UUID para el PDF.

El servidor no usa evasión de Cloudflare, CAPTCHA, rotación de IP, scraping masivo ni un modelo. Si el desafío no se completa dentro de 30 segundos, devuelve `CHALLENGE_REQUIRED` y no intenta resolverlo.

## Ejecución

Requiere Node.js 22+ y Chromium. En un entorno con display:

```bash
npm start
```

En un servidor sin display, el script incluido inicia Chromium gráfico dentro de Xvfb:

```bash
npm run start:xvfb
```

Para configurarlo en un cliente MCP, ejecuta `node` directamente para no mezclar la salida de `npm` con JSON-RPC:

```json
{
  "mcpServers": {
    "jurisprudencia-corrientes": {
      "command": "xvfb-run",
      "args": ["-a", "--server-args=-screen 0 1280x900x24 -nolisten tcp", "node", "/ruta/absoluta/api-remota/src/server.mjs"]
    }
  }
}
```

Si el cliente ya tiene `DISPLAY`, usa `node /ruta/absoluta/api-remota/src/server.mjs` sin `xvfb-run`.

Variables útiles:

- `JURIS_CHROMIUM_PATH`: ruta del ejecutable Chromium/Chrome.
- `JURIS_CHALLENGE_TIMEOUT_MS`: espera máxima del desafío, por defecto `30000`.
- `JURIS_HEADLESS=1`: solo para diagnóstico; el sitio probado rechaza este modo.
- `JURIS_USE_XVFB=0`: desactiva el arranque automático de Xvfb cuando no hay `DISPLAY`.

## Herramientas MCP

- `search_jurisprudencia`: texto, sumario, materia, año, tipo, número, legajo, categorías, voces, normativas, página y tamaño.
- `get_jurisprudencia_detail`: recibe el `id` numérico devuelto por la búsqueda y obtiene el HTML estructurado del detalle.
- `get_jurisprudencia_pdf_text`: recibe el `pdfUrl` de un resultado/detalle, captura el PDF desde Chromium y extrae texto localmente con `pdftotext`.
- `diagnose_jurisprudencia_access`: compara el acceso HTTP directo y reporta el desafío Cloudflare sin intentar resolverlo.

Las consultas limitan `perPage` a 100 (tamaños admitidos por el sitio: 10, 25, 50 y 100) y no recorren páginas automáticamente. El cliente mantiene una sola sesión de navegador y la reutiliza para evitar abrir procesos repetidos.
