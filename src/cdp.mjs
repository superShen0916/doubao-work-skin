import { assertDoubaoWorkPort } from "./app-identity.mjs";

const DEFAULT_HTTP_TIMEOUT_MS = 3_000;
const DEFAULT_OPEN_TIMEOUT_MS = 8_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export function isInspectablePageTarget(target) {
  const url = String(target?.url || "");
  return Boolean(
    (target?.type === "page" || target?.type === "iframe") &&
    target?.webSocketDebuggerUrl &&
    !url.includes("devtools://") &&
    !url.includes("chrome-extension://") &&
    url !== "about:blank" &&
    !url.includes("cross-site-support"),
  );
}

export function isSupportedPageTarget(target) {
  if (!isInspectablePageTarget(target)) return false;
  try {
    const url = new URL(target.url);
    return url.protocol === "doubaowork:" && ["doubaowork-chat", "doubaowork-launcher"].includes(url.hostname);
  }
  catch { return false; }
}

// 随 Runtime.evaluate 一起在页面内执行，导航之后也必须重新检查。
export function isDoubaoWorkPage() {
  return typeof document !== "undefined" && typeof location !== "undefined" &&
    // CDP 列表显示 doubaowork:，页面内部实际使用 chrome:（桌面端实测）。
    ["doubaowork:", "chrome:"].includes(location.protocol) &&
    ["doubaowork-chat", "doubaowork-launcher"].includes(location.hostname) &&
    Boolean(document.querySelector('[data-testid="chat-route-layout"]') && document.querySelector("#chat-route-main"));
}

export async function fetchCdpJson(port, pathname, { timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, fetchImpl = fetch, assertPortOwner = assertDoubaoWorkPort } = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error(`无效 CDP 端口: ${port}`);
  }
  if (typeof pathname !== "string" || !pathname.startsWith("/")) {
    throw new Error(`无效 CDP 路径: ${pathname}`);
  }
  await assertPortOwner(port);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${Number(port)}${pathname}`, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}: ${pathname}`);
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`CDP HTTP 超时: ${pathname}`);
    if (error?.cause?.code) {
      throw new Error(`CDP 请求失败 http://127.0.0.1:${Number(port)}${pathname}: ${error.cause.code}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function listPageTargets(port, { timeoutMs = 5_000, filter = isSupportedPageTarget, fetchImpl, assertPortOwner } = {}) {
  const list = await fetchCdpJson(port, "/json/list", { timeoutMs, fetchImpl, assertPortOwner });
  if (!Array.isArray(list)) return [];
  return list.filter(filter);
}

export class CdpSession {
  constructor(target, port, { WebSocketImpl = WebSocket, openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS, assertPortOwner = assertDoubaoWorkPort } = {}) {
    if (!target?.webSocketDebuggerUrl) throw new Error("CDP target 缺少 webSocketDebuggerUrl");
    const endpoint = new URL(target.webSocketDebuggerUrl);
    if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
        Number(endpoint.port || 80) !== Number(port) || endpoint.username || endpoint.password) {
      throw new Error("CDP WebSocket 必须指向指定端口的本机回环地址");
    }
    this.WebSocketImpl = WebSocketImpl;
    this.assertPortOwner = assertPortOwner;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.target = target;
    this.port = port;
    this.openTimeoutMs = openTimeoutMs;
  }

  async open() {
    await this.assertPortOwner(this.port);
    await new Promise((resolve, reject) => {
      this.ws = new this.WebSocketImpl(this.target.webSocketDebuggerUrl);
      const timeout = setTimeout(() => {
        try { this.ws.close(); } catch {}
        reject(new Error("CDP WebSocket 连接超时"));
      }, this.openTimeoutMs);
      this.ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("CDP WebSocket 连接失败"));
      }, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.#onMessage(event));
    this.ws.addEventListener("close", () => this.close());
    this.ws.addEventListener("error", () => this.close());
    return this;
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message?.id) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
    else waiter.resolve(message.result);
  }

  send(method, params = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error("CDP 会话已关闭"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression, awaitPromise = true, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: false,
    }, timeoutMs);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`页面执行失败: ${String(detail).slice(0, 300)}`);
    }
    return result.result?.value;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("CDP 会话已关闭"));
    }
    this.pending.clear();
    try { this.ws.close(); } catch {}
  }
}

export async function connectTarget(target, port, options = {}) {
  return new CdpSession(target, port, options).open();
}

export async function connectAllPages(port, {
  targetFilter = isSupportedPageTarget,
  onConnectionError,
  ...options
} = {}) {
  const targets = await listPageTargets(port, {
    timeoutMs: options.listTimeoutMs || 5_000,
    filter: targetFilter,
    fetchImpl: options.fetchImpl,
    assertPortOwner: options.assertPortOwner,
  });
  const sessions = [];
  for (const target of targets) {
    try {
      sessions.push(await connectTarget(target, port, options));
    } catch (error) {
      onConnectionError?.(target, error);
    }
  }
  return sessions;
}
