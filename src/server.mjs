import { JurisprudenciaClient } from "./jurisprudencia-client.mjs";

const client = new JurisprudenciaClient();

const tools = [
  {
    name: "search_jurisprudencia",
    description: "Busca fallos del STJ de Corrientes usando los filtros nativos del portal. Devuelve metadatos, IDs de detalle y URLs PDF; no resume ni interpreta el contenido.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Texto a buscar en el fallo." },
        exact: { type: "boolean", description: "Usar búsqueda exacta/literal." },
        sumario: { type: "string", description: "Texto a buscar en sumarios." },
        materias: { type: "array", items: { type: "string" }, description: "IDs o nombres: Amparo, Civil y Comercial, Laboral, Penal, etc." },
        anio: { type: "integer", description: "Año del fallo." },
        tipoFallo: { type: "string", description: "Sentencia, Resolución o el ID nativo (1/2)." },
        numeroFallo: { type: "string" },
        tipoLegajo: { type: "string", description: "Código visible del legajo (por ejemplo EXP) o ID nativo." },
        nroLegajo: { type: "string" },
        anioLegajo: { type: "string" },
        categorias: { type: "array", items: { type: "string" } },
        terminos: { type: "array", items: { type: "string" }, description: "IDs de voces del tesauro." },
        normativas: { type: "array", items: { type: "string" }, description: "IDs de normativas." },
        page: { type: "integer", minimum: 1, default: 1 },
        perPage: { type: "integer", minimum: 1, maximum: 100, default: 25 }
      }
    }
  },
  {
    name: "get_jurisprudencia_detail",
    description: "Obtiene el detalle HTML público de un fallo por el ID numérico entregado por search_jurisprudencia.",
    inputSchema: { type: "object", properties: { id: { type: ["integer", "string"], description: "ID numérico del fallo." } }, required: ["id"] }
  },
  {
    name: "get_jurisprudencia_pdf_text",
    description: "Descarga el PDF público indicado por un resultado o detalle y devuelve texto extraído localmente; no resume ni interpreta el documento.",
    inputSchema: {
      type: "object",
      properties: {
        pdfUrl: { type: "string", description: "URL PDF del portal devuelta por search_jurisprudencia o get_jurisprudencia_detail." },
        maxChars: { type: "integer", minimum: 1, maximum: 100000, default: 20000 }
      },
      required: ["pdfUrl"]
    }
  },
  {
    name: "diagnose_jurisprudencia_access",
    description: "Comprueba el acceso HTTP directo y reporta si Cloudflare devuelve un desafío, sin intentar resolverlo.",
    inputSchema: { type: "object", properties: {} }
  }
];

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  const payload = {
    error: error.message,
    code: error.code || "UPSTREAM_ERROR",
    ...(error.state ? { browserState: error.state } : {})
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

async function callTool(name, args) {
  if (name === "search_jurisprudencia") return result(await client.search(args || {}));
  if (name === "get_jurisprudencia_detail") return result(await client.detail(args?.id));
  if (name === "get_jurisprudencia_pdf_text") return result(await client.pdfText(args?.pdfUrl, args?.maxChars));
  if (name === "diagnose_jurisprudencia_access") return result(await client.diagnose());
  throw new Error(`Herramienta desconocida: ${name}`);
}

async function handle(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mcp-jurisprudencia-corrientes", version: "0.1.0" }
    };
  }
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    try {
      return await callTool(message.params?.name, message.params?.arguments);
    } catch (error) {
      return errorResult(error);
    }
  }
  if (message.method === "ping") return {};
  return {};
}

let input = "";
let requestQueue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  const lines = input.split("\n");
  input = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    requestQueue = requestQueue.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
        if (!message.id) return;
        const response = await handle(message);
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response })}\n`);
      } catch (error) {
        if (message?.id) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.message } })}\n`);
      }
    });
  }
});

const shutdown = async () => {
  await client.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
