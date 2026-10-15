// Minimal Marionette client (protocol 3): "<length>:<json>" frames over TCP, commands as [0, id, name, params].
import net from "node:net";

export class Marionette {
  constructor(port = 2828, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }

  async connect(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.#open();
        break;
      } catch (e) {
        if (Date.now() > deadline) {
          throw new Error(`Marionette nicht erreichbar: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
    await this.#hello;
    await this.send("WebDriver:NewSession", { capabilities: {} });
    await this.send("Marionette:SetContext", { value: "chrome" });
  }

  #open() {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, this.host);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        this.socket = socket;
        let helloResolve;
        this.#hello = new Promise(r => (helloResolve = r));
        this.helloResolve = helloResolve;
        socket.on("data", chunk => this.#onData(chunk));
        socket.on("error", () => {});
        resolve();
      });
    });
  }

  #hello;

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const colon = this.buffer.indexOf(":");
      if (colon < 0) {
        return;
      }
      const length = Number(this.buffer.subarray(0, colon).toString());
      if (this.buffer.length < colon + 1 + length) {
        return;
      }
      const message = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + length).toString());
      this.buffer = this.buffer.subarray(colon + 1 + length);
      if (!Array.isArray(message)) {
        this.helloResolve?.(message);
        continue;
      }
      const [, id, error, result] = message;
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        error ? p.reject(new Error(`${error.error}: ${error.message}`)) : p.resolve(result);
      }
    }
  }

  send(name, params = {}) {
    const id = this.nextId++;
    const json = JSON.stringify([0, id, name, params]);
    this.socket.write(`${Buffer.byteLength(json)}:${json}`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Runs an async function body in Thunderbird's chrome context; `args` is available as arguments[0]. */
  async run(body, args = {}) {
    const script = `const [args, __done] = arguments; (async () => { ${body} })().then(v => __done({ ok: v }), e => __done({ error: String(e) + (e && e.stack ? "\\n" + e.stack : "") }));`;
    const { value } = await this.send("WebDriver:ExecuteAsyncScript", { script, args: [args], scriptTimeout: 120000 });
    if (value?.error) {
      throw new Error(value.error);
    }
    return value?.ok;
  }

  async quit() {
    try {
      await this.send("Marionette:Quit", { flags: ["eForceQuit"] });
    } catch {
      // Connection drops while quitting.
    }
    this.socket?.destroy();
  }
}
