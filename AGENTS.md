# AGENTS.md

## Propósito

Este proyecto conserva y consulta jurisprudencia pública del Superior Tribunal de Justicia de Corrientes. Tiene cuatro superficies relacionadas:

- **Descarga / actualización**: captura PDFs remotos y los organiza en un archivo local.
- **Consulta IA**: consulta primero el archivo local y genera una respuesta con el modelo configurado.
- **Portal principal**: reúne los accesos a las aplicaciones y documenta el MCP.
- **MCP por stdio**: expone herramientas reutilizables para buscar y obtener fallos del portal oficial.

La regla general es no destructiva: no reemplazar PDFs originales, no borrar datos y no modificar una captura existente para resolver una consulta.

## Servicios y puertos

Todos los servicios usan `network_mode: host` en `docker-compose.yml`:

| Servicio | Puerto | Modo | Función |
|---|---:|---|---|
| `jurisprudencia-web` | 3000 | `APP_MODE=archive` | Descarga, actualización, reintentos y navegación del archivo |
| `jurisprudencia-query` | 3001 | `APP_MODE=query` | Consulta local con IA y ampliación remota opcional |
| `jurisprudencia-portal` | 3002 | servidor del portal | Portal principal y documentación del MCP |

No cambiar el puerto de Descarga para resolver necesidades de Consulta. Si se actualiza la imagen, reiniciar únicamente el servicio afectado cuando sea posible.

## Persistencia y nomenclatura

El bind mount `${DATA_DIR:-./data}:/data` conserva los datos en el directorio local del proyecto, fuera del almacenamiento interno de Docker. La estructura humana de un PDF es:

```text
data/<año>/<MM-mes>/semana-<semana>/<DD-MM-AAAA>/<materia>/<número>-<fecha>-<título>.pdf
```

Ejemplo:

```text
data/2026/08-agosto/semana-35/25-08-2026/amparo/000123-25-08-2026-accion-ioscor.pdf
```

Cada PDF puede tener un JSON lateral con el mismo nombre más `.json` y un Markdown derivado con el mismo nombre reemplazando `.pdf` por `.md`.

- `manifest.json` es el índice principal de la aplicación de Descarga.
- `.query-archive.json` es un índice adicional de capturas creadas desde la ampliación remota de Consulta; no reemplaza ni edita `manifest.json`.
- `data/` es estado local y no debe entrar en commits.

## Aplicación de Consulta

`src/web-server.mjs` usa `LocalArchiveSearch` de `src/local-search.mjs` cuando `APP_MODE=query`.

1. Lee `manifest.json` y, si existe, `.query-archive.json`.
2. Lee los JSON laterales antes de seleccionar documentos.
3. Aplica año, mes y materia/categoría opcionales.
4. Si hace falta contenido, busca el `.md` lateral.
5. Si el PDF no tiene `.md`, ejecuta `pdftotext` en memoria y crea el derivado con escritura exclusiva (`flag: "wx"`).
6. No existe un límite fijo de cantidad para la consulta local: incorpora todos los candidatos hasta `LOCAL_CONTEXT_MAX_BYTES` (por defecto, aproximadamente 100 KiB de JSON y Markdown).
7. Entrega a la IA únicamente `metadata` y `markdown`; el prompt prohíbe leer el PDF binario directamente.

El contenedor de Consulta monta `/data` como solo lectura y `/data-write` como ruta separada de escritura. Las escrituras locales normales están limitadas a Markdown derivados. El `manifest.json`, los PDFs y los JSON existentes no se modifican.

La interfaz está en `public-query/`. La respuesta incluye una columna lateral “Fuentes leídas” con nombre y ruta relativa, y enlaces a:

- `/api/local/markdown?path=...`
- `/api/local/metadata?path=...`
- `/api/local/file?path=...`

Las rutas deben validarse contra la raíz de datos antes de leerlas.

Después de una consulta, la respuesta incluye `contextReview` con los candidatos encontrados, los documentos enviados y los omitidos por presupuesto de contexto. La interfaz muestra esos conteos en un frame previo a la respuesta, permite abrir y copiar cada listado y ofrece `retryAllDocuments: true` para repetir la consulta local sin el límite de 100 KiB. El reintento puede superar la ventana del modelo y debe informar el error si ocurre.

Los errores de OpenCode no deben quedar mezclados únicamente con la respuesta generada. `synthesize()` devuelve `aiError` con código, título, mensaje y acción sugerida; reconoce especialmente timeout (`OPENCODE_TIMEOUT`) y exceso de contexto (`OPENCODE_CONTEXT_LIMIT`). Si existe texto parcial, se conserva como `partialAnswer` y la interfaz lo presenta como respuesta incompleta.

## Checkbox de ampliación remota

`includeRemote=true` es una ampliación acotada, no el modo normal de Consulta:

1. Se ejecuta la búsqueda remota y se obtienen detalles.
2. Cada resultado se compara localmente por ID o fuente.
3. Los documentos encontrados localmente no vuelven a descargarse.
4. Solo un faltante con URL PDF solicita `download_jurisprudencia_pdf` por MCP.
5. El PDF nuevo se guarda con `archiveMissingRemote()` usando la nomenclatura normal.
6. Se crea su JSON lateral con escritura exclusiva y luego su `.md` derivado, sin alterar el PDF.
7. La IA utiliza el Markdown local resultante.

Si falla Cloudflare, el acceso remoto o la conversión, la respuesta local debe conservarse y la API debe informar la advertencia. No convertir un fallo remoto en pérdida de la respuesta local.

`get_jurisprudencia_pdf_text` se conserva para compatibilidad del MCP, pero el flujo de Consulta no debe usarlo para alimentar directamente a la IA: la ruta nueva debe archivar el PDF faltante y leer después su `.md`.

## MCP

El servidor está en `src/server.mjs` y se inicia bajo demanda mediante `LocalMcpClient`:

- `search_jurisprudencia`: búsqueda con filtros nativos del portal.
- `get_jurisprudencia_detail`: detalle HTML de un fallo.
- `get_jurisprudencia_pdf_text`: compatibilidad para extraer texto de un PDF.
- `download_jurisprudencia_pdf`: bytes PDF en base64 para archivar un faltante confirmado.
- `diagnose_jurisprudencia_access`: diagnóstico de acceso y Cloudflare.

No ejecutar búsquedas MCP ni descargas remotas durante una captura activa de la aplicación de Descarga sin coordinación explícita: ambas aplicaciones comparten el portal remoto y el directorio persistente.

## Docker y configuración

La imagen instala Chromium, Xvfb y `poppler-utils`. `docker-entrypoint.sh` ejecuta Node como usuario `app`; en Consulta se omite el `chown` recursivo porque `/data` es de solo lectura.

El modelo LLM se configura en Compose mediante:

```text
OPENCODE_ENABLED=1
OPENCODE_MODEL=opencode/muse-spark-1.2-contributor-free
```

La interfaz de Consulta actualiza la lista de modelos free mediante `GET /api/models`, permite elegir el modelo con “Elegir IA” y envía la selección junto con cada consulta. La síntesis completa usa `OPENCODE_TIMEOUT_MS` (180000 ms por defecto); el diagnóstico de respuesta mínima mantiene 30000 ms. Las variables principales están en `.env.example`: puertos, `DATA_DIR`, modo de acceso remoto, límites de documentos, límites de PDF, reintentos y parámetros de OpenCode.

## Desarrollo y verificación

Ejecutar desde la raíz:

```bash
npm test
node --check public-query/app.js
node --check src/ai.mjs
node --check src/web-server.mjs
node --check src/local-search.mjs
node --check src/server.mjs
node --check src/export.mjs
git diff --check
```

Para actualizar únicamente Consulta:

```bash
sudo docker compose up -d --build --no-deps jurisprudencia-query
```

Verificar `/api/health` en `http://127.0.0.1:3001/api/health`. Un health correcto de Consulta debe mostrar `appMode: "query"`, `nonDestructiveQuery: true`, `derivedMarkdownOnly: true` y, si no se solicitó ampliación, `mcpStarted: false`.

No probar el checkbox remoto contra el portal real mientras otra aplicación esté descargando. Las pruebas automatizadas deben usar bytes y directorios temporales, sin llamar al MCP ni al sitio remoto.

## Git

Antes de crear un commit, confirmar que `data/` no esté incluido:

```bash
git status --short
git diff --check
git add AGENTS.md README.md public-query portal src test docker-compose.yml Dockerfile package.json
git commit -m "describir el cambio"
git push origin main
```

No usar `git add .` si existe riesgo de incluir datos locales. Nunca ejecutar `git reset --hard`, borrar `data/` o reemplazar PDFs como parte de una tarea normal.
