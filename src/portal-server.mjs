import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC = resolve(process.env.PORTAL_DIR || join(ROOT, "portal"));
const PORT = Number(process.env.PORT || 3002);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    return response.end("Método no permitido");
  }
  const pathname = new URL(request.url || "/", "http://" + (request.headers.host || "localhost")).pathname;
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = resolve(PUBLIC, "." + requested);
  if (!file.startsWith(PUBLIC + "/")) {
    response.writeHead(403);
    return response.end("Ruta no permitida");
  }
  try {
    const data = await readFile(file);
    response.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    return response.end(request.method === "HEAD" ? undefined : data);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return response.end("Página no encontrada");
  }
});

server.listen(PORT, "0.0.0.0", () => console.log("Portal principal escuchando en http://localhost:" + PORT));
