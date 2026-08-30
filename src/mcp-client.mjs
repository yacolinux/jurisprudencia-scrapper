import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class LocalMcpClient {
  constructor({ command = process.env.MCP_COMMAND || process.execPath, args, timeoutMs = 120_000 } = {}) {
    this.command = command;
    this.args = args ?? [resolve(ROOT, "src/server.mjs")];
    this.timeoutMs = timeoutMs;
    this.process = null;
    this.buffer = "";
    this.pending = new Map();
    this.started = false;
  }

  async start() {
    if (this.started) return this;
    this.process = spawn(this.command, this.args, {
      cwd: ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.#consume(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => {
      if (process.env.MCP_DEBUG === "1") process.stderr.write(`[mcp] ${chunk}`);
    });
    this.process.on("error", (error) => this.#rejectAll(new Error(`No se pudo iniciar el MCP: ${error.message}`)));
    this.process.on("exit", (code, signal) => {
      this.started = false;
      if (this.pending.size) this.#rejectAll(new Error(`El proceso MCP terminó (${code ?? signal ?? "desconocido"})`));
    });
    this.started = true;
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mvp-jurisprudencia-web", version: "0.1.0" }
    });
    return this;
  }

  async callTool(name, args = {}) {
    await this.start();
    const response = await this.request("tools/call", { name, arguments: args });
    const text = response?.content?.find((item) => item.type === "text")?.text;
    if (!text) return response;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = { text };
    }
    if (response.isError) {
      const error = new Error(value.error || "El MCP devolvió un error");
      error.code = value.code || "MCP_ERROR";
      error.browserState = value.browserState;
      throw error;
    }
    return value;
  }

  request(method, params = {}) {
    if (!this.process?.stdin?.writable) return Promise.reject(new Error("El MCP no está disponible"));
    const id = randomUUID();
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout esperando ${method} del MCP`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.process.stdin.write(`${payload}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  #consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Error JSON-RPC del MCP"));
      else pending.resolve(message.result);
    }
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close() {
    this.#rejectAll(new Error("Cliente MCP cerrado"));
    if (this.process && !this.process.killed) this.process.kill("SIGTERM");
    this.process = null;
    this.started = false;
  }
}
