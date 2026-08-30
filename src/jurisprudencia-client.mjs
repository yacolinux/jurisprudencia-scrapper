import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE_URL = "https://jurisprudencia.juscorrientes.gov.ar";
const SEARCH_PATH = "/jurisprudencia/fallos/fallosstj";
const ADVANCED_URL = `${BASE_URL}${SEARCH_PATH}?filtros=1`;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const SUPPORTED_PAGE_SIZES = new Set([10, 25, 50, 100]);
const MAX_PAGE = 10_000;

const MATERIA_IDS = {
  amparo: "2",
  "civil y comercial": "1",
  "conflicto de poderes": "7",
  electoral: "6",
  "habeas data": "9",
  laboral: "4",
  menores: "10",
  penal: "5",
  "proc. administrativo": "3",
  "procedimiento administrativo": "3",
  superintendencia: "8",
};

const CATEGORIA_IDS = {
  "perspectiva de género": "1",
  "leading case": "2",
  trascendentales: "3",
  precedente: "5",
};

const TYPE_IDS = { resolución: "1", resolucion: "1", sentencia: "2" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function asArray(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeIdList(value, dictionary = {}) {
  return asArray(value).map((item) => {
    const raw = String(item).trim();
    const normalized = raw.toLocaleLowerCase("es");
    return dictionary[normalized] ?? raw;
  });
}

function setScalar(params, key, value) {
  if (value !== undefined && value !== null && String(value) !== "") {
    params.set(key, String(value));
  }
}

function buildSearchUrl(filters = {}) {
  const params = new URLSearchParams({ filtros: "1" });
  setScalar(params, "texto", filters.text ?? filters.query);
  if (filters.exact === true || filters.busquedaExacta === true) params.set("busqueda_exacta", "1");
  setScalar(params, "sumario", filters.sumario);
  for (const id of normalizeIdList(filters.materias, MATERIA_IDS)) params.append("materias[]", id);
  setScalar(params, "anio", filters.anio ?? filters.year);
  const type = filters.tipoFallo ?? filters.type;
  setScalar(params, "tipo_fallo", TYPE_IDS[String(type ?? "").toLocaleLowerCase("es")] ?? type);
  setScalar(params, "numero_fallo", filters.numeroFallo ?? filters.falloNumber);
  setScalar(params, "tipo_legajo", filters.tipoLegajo ?? filters.legajoType);
  setScalar(params, "nro_legajo", filters.nroLegajo ?? filters.legajoNumber);
  setScalar(params, "anio_legajo", filters.anioLegajo ?? filters.legajoYear);
  for (const id of normalizeIdList(filters.categorias ?? filters.categories, CATEGORIA_IDS)) params.append("categorias[]", id);
  for (const id of asArray(filters.terminos ?? filters.terms)) params.append("terminos[]", String(id));
  for (const id of asArray(filters.normativas ?? filters.regulations)) params.append("normativas[]", String(id));

  const page = Number(filters.page ?? 1);
  const perPage = Number(filters.perPage ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) throw new Error(`page debe estar entre 1 y ${MAX_PAGE}`);
  if (!Number.isInteger(perPage) || !SUPPORTED_PAGE_SIZES.has(perPage)) {
    throw new Error("perPage debe ser uno de los tamaños admitidos por el sitio: 10, 25, 50 o 100");
  }
  if (page !== 1) params.set("page", String(page));
  if (perPage !== DEFAULT_PAGE_SIZE) params.set("per_page", String(perPage));
  return `${BASE_URL}${SEARCH_PATH}?${params.toString()}`;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith("https:") ? httpsGet : httpGet;
    const request = getter(url, { headers: { Accept: "application/json" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) });
        } catch {
          reject(new Error("El endpoint de Chrome devolvió una respuesta no JSON"));
        }
      });
    });
    request.once("error", reject);
    request.setTimeout(5_000, () => request.destroy(new Error("Timeout conectando con Chrome")));
  });
}

function decodeHtml(value = "") {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function textFromHtml(value = "") {
  return decodeHtml(value.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function htmlAttribute(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? decodeHtml(match[1]) : null;
}

function challengeResponse(response, body) {
  return response.headers.get("cf-mitigated") === "challenge" || /security check|required|just a moment|verificando la conexión|enable javascript and cookies/i.test(body.slice(0, 50_000));
}

async function directFetch(url, { binary = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.JURIS_DIRECT_TIMEOUT_MS || 20_000));
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal, headers: { Accept: binary ? "application/pdf" : "text/html" } });
    const body = binary ? Buffer.from(await response.arrayBuffer()) : await response.text();
    if (challengeResponse(response, binary ? "" : body)) {
      const error = new Error("El acceso HTTP directo recibió un desafío de Cloudflare");
      error.code = "CHALLENGE_REQUIRED";
      throw error;
    }
    if (!response.ok) throw new Error(`El portal respondió HTTP ${response.status}`);
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

function parseDirectSearch(html, requestedUrl) {
  const pageText = textFromHtml(html);
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => {
    const row = match[0];
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => textFromHtml(cell[1]));
    const detail = row.match(/data-id\s*=\s*["'](\d+)["']/i);
    const pdf = row.match(/href\s*=\s*["']([^"']*(?:ver-pdf|ver_pdf_proxy)[^"']*)["']/i);
    if (cells.length < 5) return null;
    return { fallo: cells[0], expediente: cells[1], caratula: cells[2], materia: cells[3], fecha: cells[4], id: detail?.[1] || null, pdfUrl: pdf?.[1] ? new URL(pdf[1], BASE_URL).href : null };
  }).filter((row) => row?.id || row?.pdfUrl);
  return parseSearchResult({ pageText, rows }, requestedUrl);
}

function parseDirectDetail(html, id, requestedUrl) {
  const heading = textFromHtml(html.match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i)?.[1] || "");
  const title = textFromHtml(html.match(/<div[^>]*class=["'][^"']*datos-fallo[^"']*["'][^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "");
  const sections = [...html.matchAll(/<[^>]*class=["'][^"']*accordion-item[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi)].map((match) => ({ heading: textFromHtml(match[1].match(/<[^>]*class=["'][^"']*(?:accordion-header|accordion-button)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || ""), text: textFromHtml(match[1]) })).filter((section) => section.text);
  const pdfMatch = html.match(/href\s*=\s*["']([^"']*(?:ver-pdf|ver_pdf_proxy)[^"']*)["']/i);
  return { id: Number(id), source: requestedUrl, heading, title, metadata: textFromHtml(html.match(/<div[^>]*class=["'][^"']*datos-fallo[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || ""), sections, pdfUrl: pdfMatch?.[1] ? new URL(pdfMatch[1], BASE_URL).href : null, text: textFromHtml(html) };
}

async function extractPdfText(pdf, url, maxChars) {
  const workDir = await mkdtemp(join(tmpdir(), "mcp-jurisprudencia-pdf-"));
  const file = join(workDir, "fallo.pdf");
  try {
    await writeFile(file, pdf);
    const text = await new Promise((resolve, reject) => {
      execFile("pdftotext", ["-layout", file, "-"], { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`pdftotext no pudo leer el PDF: ${stderr.trim() || error.message}`));
        else resolve(stdout);
      });
    });
    return { source: url, contentType: "application/pdf", bytes: pdf.length, chars: text.length, truncated: text.length > maxChars, text: text.slice(0, maxChars) };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

class CdpConnection {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", (event) => reject(new Error(`No se pudo abrir CDP: ${event.message ?? "error"}`)), { once: true });
    });
    this.socket.addEventListener("message", (event) => this.handleMessage(JSON.parse(event.data)));
    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("La conexión CDP se cerró"));
      this.pending.clear();
    });
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    return this;
  }

  handleMessage(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    const listeners = this.events.get(message.method) ?? [];
    for (const listener of listeners) listener(message.params);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.events.get(method) ?? [];
    listeners.push(listener);
    this.events.set(method, listeners);
  }

  off(method, listener) {
    const listeners = this.events.get(method) ?? [];
    this.events.set(method, listeners.filter((item) => item !== listener));
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text ?? "Error evaluando JavaScript en la página");
    }
    return response.result?.value;
  }

  async close({ closeBrowser = true } = {}) {
    if (closeBrowser) {
      try {
        await this.send("Browser.close");
      } catch {
        // El proceso puede haber terminado antes que la conexión.
      }
    }
    this.socket?.close();
  }
}

class BrowserSession {
  constructor() {
    this.browserProcess = null;
    this.xvfbProcess = null;
    this.profileDir = null;
    this.cdp = null;
    this.started = false;
    this.external = false;
  }

  async start() {
    if (this.started) return this;
    const externalCdpUrl = process.env.JURIS_CDP_URL?.replace(/\/+$/, "");
    if (externalCdpUrl) {
      const response = await requestJson(`${externalCdpUrl}/json/list`);
      const target = response.body.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (!target) throw new Error(`No se encontró una pestaña page en ${externalCdpUrl}`);
      this.cdp = await new CdpConnection(target.webSocketDebuggerUrl).connect();
      this.external = true;
      // La pestaña externa puede estar en about:blank o ya tener una sesión
      // válida. En ambos casos las operaciones MCP navegarán a su URL final;
      // no forzamos una visita previa a la raíz, que puede disparar Cloudflare.
      this.ready = true;
      this.started = true;
      return this;
    }
    this.profileDir = await mkdtemp(join(tmpdir(), "mcp-jurisprudencia-"));
    const port = await findFreePort();
    const configuredPath = process.env.JURIS_CHROMIUM_PATH || "chromium";
    const headless = process.env.JURIS_HEADLESS === "1";
    const env = { ...process.env };

    if (!headless && !env.DISPLAY && process.env.JURIS_USE_XVFB !== "0") {
      const display = `:${100 + (process.pid % 800)}`;
      this.xvfbProcess = spawn("Xvfb", [display, "-screen", "0", "1280x900x24", "-nolisten", "tcp"], {
        stdio: "ignore",
      });
      env.DISPLAY = display;
      await sleep(300);
    }

    const args = [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-dev-shm-usage",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${this.profileDir}`,
      "about:blank",
    ];
    if (headless) args.unshift("--headless=new");

    this.browserProcess = spawn(configuredPath, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let launchError = "";
    this.browserProcess.stderr.on("data", (chunk) => (launchError += chunk.toString()));
    this.browserProcess.once("error", (error) => (launchError += error.message));

    let target;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await requestJson(`http://127.0.0.1:${port}/json/list`);
        target = response.body.find((item) => item.type === "page");
        if (target) break;
      } catch {
        // Chrome todavía está iniciando.
      }
      await sleep(200);
    }
    if (!target) {
      await this.stop();
      throw new Error(`No se pudo iniciar Chromium: ${launchError.slice(-500)}`);
    }

    this.cdp = await new CdpConnection(target.webSocketDebuggerUrl).connect();
    this.started = true;
    return this;
  }

  async stop() {
    await this.cdp?.close({ closeBrowser: !this.external });
    this.browserProcess?.kill("SIGTERM");
    this.xvfbProcess?.kill("SIGTERM");
    if (this.profileDir) await rm(this.profileDir, { recursive: true, force: true });
    this.browserProcess = null;
    this.xvfbProcess = null;
    this.cdp = null;
    this.started = false;
    this.external = false;
  }

  async navigate(url) {
    await this.cdp.send("Page.navigate", { url });
    await sleep(400);
    const deadline = Date.now() + Number(process.env.JURIS_CHALLENGE_TIMEOUT_MS || 60_000);
    let lastState;
    while (Date.now() < deadline) {
      lastState = await this.cdp.evaluate(`(() => ({
        title: document.title,
        ready: document.readyState,
        url: location.href,
        text: document.body?.innerText?.slice(0, 1200) || ""
      }))()`);
      const challenge = /security check|required|just a moment|verificando la conexión|enable javascript and cookies/i.test(`${lastState?.title}\n${lastState?.text}`);
      if (lastState?.ready === "complete" && !challenge) return lastState;
      await sleep(challenge ? 700 : 250);
    }
    const error = new Error("Cloudflare no completó el desafío dentro del tiempo permitido");
    error.code = "CHALLENGE_REQUIRED";
    error.state = lastState;
    throw error;
  }

  async ensureStarted() {
    await this.start();
    if (!this.ready) {
      await this.navigate(BASE_URL + "/");
      this.ready = true;
    }
  }

  async capturePdf(url) {
    await this.cdp.send("Network.enable");
    await this.cdp.send("Fetch.enable", {
      patterns: [
        { urlPattern: "*ver-pdf*", requestStage: "Response" },
        { urlPattern: "*ver_pdf_proxy*", requestStage: "Response" }
      ]
    }).catch(() => {});
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(new Error("Timeout esperando la respuesta PDF")), Number(process.env.JURIS_PDF_TIMEOUT_MS || 30_000));
        const networkPdfRequests = new Set();
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.cdp.off("Network.responseReceived", onResponse);
          this.cdp.off("Network.loadingFinished", onFinished);
          this.cdp.off("Fetch.requestPaused", onPaused);
          if (error) reject(error);
          else resolve(value);
        };
        const isPdf = (response) => response?.mimeType === "application/pdf" || /(?:ver-pdf|ver_pdf_proxy)/i.test(response?.url || "");
        const readNetworkBody = async (requestId) => {
          try {
            const result = await this.cdp.send("Network.getResponseBody", { requestId });
            finish(null, result.base64Encoded ? Buffer.from(result.body, "base64") : Buffer.from(result.body));
          } catch {
            // Chrome puede hacer disponible el body recién en loadingFinished.
          }
        };
        const onResponse = async (params) => {
          if (isPdf(params.response)) {
            networkPdfRequests.add(params.requestId);
            await readNetworkBody(params.requestId);
          }
        };
        const onFinished = async (params) => {
          if (networkPdfRequests.has(params.requestId)) await readNetworkBody(params.requestId);
        };
        const continueResponse = async (requestId) => {
          await this.cdp.send("Fetch.continueResponse", { requestId }).catch(() => this.cdp.send("Fetch.continueRequest", { requestId }));
        };
        const onPaused = async (params) => {
          const headers = Object.fromEntries((params.responseHeaders ?? []).map((header) => [header.name.toLocaleLowerCase(), header.value]));
          const contentType = headers["content-type"]?.split(";", 1)[0]?.trim().toLocaleLowerCase();
          if (contentType !== "application/pdf") {
            await continueResponse(params.requestId).catch((error) => finish(error));
            return;
          }
          try {
            const result = await this.cdp.send("Fetch.getResponseBody", { requestId: params.requestId });
            await continueResponse(params.requestId).catch(() => {});
            finish(null, result.base64Encoded ? Buffer.from(result.body, "base64") : Buffer.from(result.body));
          } catch (error) {
            finish(error);
          }
        };
        this.cdp.on("Network.responseReceived", onResponse);
        this.cdp.on("Network.loadingFinished", onFinished);
        this.cdp.on("Fetch.requestPaused", onPaused);
        this.cdp.send("Page.navigate", { url }).catch((error) => finish(error));
      });
    } finally {
      await this.cdp.send("Network.disable").catch(() => {});
      await this.cdp.send("Fetch.disable").catch(() => {});
    }
  }
}

function parseSearchResult(value, requestedUrl) {
  const pageText = value.pageText ?? "";
  const countMatch = pageText.match(/([\d.]+)\s+fallos? encontrados?/i);
  const pageMatch = pageText.match(/Mostrando\s+([\d–-]+)\s+·\s+Página\s+([\d.]+)\s+de\s+([\d.]+)/i);
  return {
    source: requestedUrl,
    total: countMatch ? Number(countMatch[1].replaceAll(".", "")) : null,
    page: pageMatch ? Number(pageMatch[2].replaceAll(".", "")) : null,
    totalPages: pageMatch ? Number(pageMatch[3].replaceAll(".", "")) : null,
    results: value.rows ?? [],
  };
}

export class JurisprudenciaClient {
  constructor() {
    this.session = new BrowserSession();
    this.mapPromise = null;
  }

  async search(filters = {}) {
    const url = buildSearchUrl(filters);
    const accessMode = process.env.JURIS_ACCESS_MODE || "auto";
    const needsBrowserMapping = filters.tipoLegajo && !/^\d+$/.test(String(filters.tipoLegajo));
    if (accessMode !== "browser" && !needsBrowserMapping) {
      try {
        const { body } = await directFetch(url);
        return parseDirectSearch(body, url);
      } catch (error) {
        if (accessMode === "direct") throw error;
        // El portal suele proteger el tráfico directo con Cloudflare. Auto usa el
        // navegador virtual solamente cuando ese camino es necesario.
      }
    }
    await this.session.ensureStarted();

    if (filters.tipoLegajo && !/^\d+$/.test(String(filters.tipoLegajo))) {
      this.mapPromise ??= this.loadLegajoMap();
      const map = await this.mapPromise;
      const mapped = map[String(filters.tipoLegajo).toLocaleLowerCase("es")];
      if (mapped) {
        const adjusted = { ...filters, tipoLegajo: mapped };
        return this.search(adjusted);
      }
    }

    await this.session.navigate(url);
    const data = await this.session.cdp.evaluate(`(() => {
      const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
      const rows = [...document.querySelectorAll("table tbody tr")].map((tr) => {
        const cells = [...tr.querySelectorAll("td")];
        const detail = tr.querySelector(".buttonmasdatos[data-id]");
        const pdf = tr.querySelector('a[href*="/ver-pdf/"]');
        const caratulaNode = cells[2]?.cloneNode(true);
        caratulaNode?.querySelector(".fragmento-destacado")?.remove();
        return {
          fallo: clean(cells[0]?.innerText),
          expediente: clean(cells[1]?.innerText),
          caratula: clean(caratulaNode?.innerText),
          materia: clean(cells[3]?.innerText),
          fecha: clean(cells[4]?.innerText),
          id: detail?.getAttribute("data-id") || null,
          pdfUrl: pdf?.href || null
        };
      });
      return { pageText: document.body?.innerText || "", rows };
    })()`);
    return parseSearchResult(data, url);
  }

  async loadLegajoMap() {
    await this.session.ensureStarted();
    await this.session.navigate(ADVANCED_URL);
    return this.session.cdp.evaluate(`(() => Object.fromEntries([...document.querySelectorAll("#tipoLegajoInput option")].map(o => [o.textContent.trim().toLocaleLowerCase("es"), o.value])))()`);
  }

  async detail(id) {
    const normalized = String(id).trim();
    if (!/^\d+$/.test(normalized)) throw new Error("id debe ser el ID numérico del fallo expuesto por el buscador");
    const url = `${BASE_URL}/jurisprudencia/fallos/detalle_ajax/${normalized}`;
    const accessMode = process.env.JURIS_ACCESS_MODE || "auto";
    if (accessMode !== "browser") {
      try {
        const { body } = await directFetch(url);
        return parseDirectDetail(body, normalized, url);
      } catch (error) {
        if (accessMode === "direct") throw error;
      }
    }
    await this.session.ensureStarted();
    await this.session.navigate(url);
    const data = await this.session.cdp.evaluate(`(() => {
      const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
      const heading = clean(document.querySelector("h4")?.innerText);
      const title = clean(document.querySelector(".datos-fallo p")?.innerText);
      const metadata = clean([...document.querySelectorAll(".datos-fallo")].at(-1)?.innerText);
      const sections = [...document.querySelectorAll(".accordion-item")].map((item) => ({
        heading: clean(item.querySelector(".accordion-header, .accordion-button")?.innerText),
        text: clean(item.innerText)
      })).filter(section => section.text);
      const pdfUrl = [...document.querySelectorAll("a")].map(a => a.href).find(href => href.includes("ver_pdf_proxy") || href.includes("/ver-pdf/")) || null;
      return { heading, title, metadata, sections, pdfUrl, text: clean(document.body?.innerText) };
    })()`);
    return { id: Number(normalized), source: url, ...data };
  }

  async pdfText(pdfUrl, maxChars = 20_000) {
    const url = new URL(String(pdfUrl));
    if (url.origin !== BASE_URL || !/^\/(?:ver-pdf|jurisprudencia\/fallos\/ver_pdf_proxy)\//.test(url.pathname)) {
      throw new Error("pdfUrl debe ser una URL PDF del portal devuelta por la búsqueda o el detalle");
    }
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 100_000) {
      throw new Error("maxChars debe estar entre 1 y 100000");
    }
    const accessMode = process.env.JURIS_ACCESS_MODE || "auto";
    if (accessMode !== "browser") {
      try {
        const { body } = await directFetch(url.href, { binary: true });
        return await extractPdfText(body, url.href, maxChars);
      } catch (error) {
        if (accessMode === "direct") throw error;
      }
    }
    await this.session.ensureStarted();
    const pdf = await this.session.capturePdf(url.href);
    return extractPdfText(pdf, url.href, maxChars);
  }

  async downloadPdf(pdfUrl) {
    const url = new URL(String(pdfUrl));
    if (url.origin !== BASE_URL || !/^\/(?:ver-pdf|jurisprudencia\/fallos\/ver_pdf_proxy)\//.test(url.pathname)) {
      throw new Error("pdfUrl debe ser una URL PDF del portal devuelta por la búsqueda o el detalle");
    }
    const accessMode = process.env.JURIS_ACCESS_MODE || "auto";
    if (accessMode !== "browser") {
      try {
        const { body } = await directFetch(url.href, { binary: true });
        return body;
      } catch (error) {
        if (accessMode === "direct") throw error;
      }
    }
    await this.session.ensureStarted();
    return this.session.capturePdf(url.href);
  }

  async diagnose() {
    const cdpUrl = process.env.JURIS_CDP_URL?.replace(/\/+$/, "");
    let cdpReachable = false;
    if (cdpUrl) {
      try {
        const response = await requestJson(`${cdpUrl}/json/version`);
        cdpReachable = response.status >= 200 && response.status < 300;
      } catch {
        cdpReachable = false;
      }
    }
    const response = await fetch(BASE_URL + "/", { redirect: "manual" });
    const body = await response.text();
    const challenge = response.headers.get("cf-mitigated") === "challenge" || /Security Check Required|Verificando la conexión/i.test(body);
    return {
      url: BASE_URL + "/",
      status: response.status,
      contentType: response.headers.get("content-type"),
      cloudflareMitigated: response.headers.get("cf-mitigated"),
      cloudflareRay: response.headers.get("cf-ray"),
      challenge,
      cdpConfigured: Boolean(cdpUrl),
      cdpReachable,
      recommendedAccessMode: cdpReachable ? "cdp" : challenge ? "browser" : "direct",
      configuredAccessMode: process.env.JURIS_ACCESS_MODE || "auto",
      message: cdpReachable
        ? "Hay un Chrome externo disponible por CDP; el MCP lo reutilizará para conservar la sesión gráfica que supera el desafío."
        : challenge
        ? "El acceso HTTP directo recibe el desafío de Cloudflare; en modo auto las consultas usan Chromium dentro de Xvfb para conservar una sesión normal."
        : "El acceso HTTP directo no fue bloqueado en esta prueba; en modo auto se evita iniciar Chromium."
    };
  }

  async close() {
    await this.session.stop();
  }
}

export { BASE_URL, buildSearchUrl };
