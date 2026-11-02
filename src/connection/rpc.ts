import { log, redact } from "../log";
import { SUPPORTED_PROTOCOL } from "./discovery";

type Json = unknown;

interface Pending {
  onChunk?: (values: Json[]) => void;
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  values: Json[];
}

export interface RpcExit {
  _tag: "Success" | "Failure";
  value?: Json;
  cause?: Json;
}

/**
 * Minimal client for T3 Code's Effect RPC protocol over `/ws` (JSON serialization).
 * Requests are `{_tag:"Request",id,tag,payload,headers}`; streams answer with `Chunk`s that the
 * client acknowledges, and every request ends with one `Exit`.
 */
export class RpcClient {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private closedByUser = false;

  constructor(
    private readonly httpBaseUrl: string,
    private readonly bearer: () => Promise<string>,
    private readonly onState: (state: "open" | "closed", reason?: string) => void,
  ) {}

  async connect(): Promise<void> {
    this.closedByUser = false;
    const token = await this.bearer();
    const ticketResponse = await fetch(new URL("/api/auth/websocket-ticket", this.httpBaseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (ticketResponse.status === 401 || ticketResponse.status === 403) {
      throw new UnauthorizedError(`T3 Code rejected the saved credentials (${ticketResponse.status}).`);
    }
    if (!ticketResponse.ok) throw new Error(`Could not get a WebSocket ticket (${ticketResponse.status}).`);
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    const url = new URL("/ws", this.httpBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("orchestrationProtocol", String(SUPPORTED_PROTOCOL));
    url.searchParams.set("clientSurface", "web");
    url.searchParams.set("wsTicket", ticket);

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      let opened = false;
      socket.onopen = () => {
        opened = true;
        this.pingTimer = setInterval(() => this.send({ _tag: "Ping" }), 20_000);
        this.onState("open");
        resolve();
      };
      socket.onerror = () => {
        if (!opened) reject(new Error(`WebSocket to ${redact(url.toString())} failed.`));
      };
      socket.onclose = (event) => {
        clearInterval(this.pingTimer);
        const reason = event.reason || `code ${event.code}`;
        for (const pending of this.pending.values()) pending.reject(new Error(`Connection closed (${reason}).`));
        this.pending.clear();
        if (opened && !this.closedByUser) this.onState("closed", reason);
      };
      socket.onmessage = (event) => this.handle(String(event.data));
    });
  }

  close(): void {
    this.closedByUser = true;
    clearInterval(this.pingTimer);
    this.socket?.close();
    this.socket = undefined;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** A unary call; resolves with the success value or rejects with the failure. */
  call<T = Json>(tag: string, payload: Json): Promise<T> {
    return this.request(tag, payload) as Promise<T>;
  }

  /** A streaming call. `onChunk` receives each batch; the promise settles when the stream ends. */
  stream(tag: string, payload: Json, onChunk: (values: Json[]) => void): { done: Promise<Json>; cancel: () => void } {
    const id = String(this.nextId);
    const done = this.request(tag, payload, onChunk);
    return { done, cancel: () => this.send({ _tag: "Interrupt", requestId: id }) };
  }

  private request(tag: string, payload: Json, onChunk?: (values: Json[]) => void): Promise<Json> {
    if (!this.isOpen) return Promise.reject(new Error("Not connected to T3 Code."));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onChunk, values: [] });
      this.send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  private send(message: Json): void {
    if (this.isOpen) this.socket!.send(JSON.stringify(message));
  }

  private handle(raw: string): void {
    let message: { _tag: string; requestId?: string; values?: Json[]; exit?: RpcExitWire; defect?: Json };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const pending = message.requestId === undefined ? undefined : this.pending.get(message.requestId);
    switch (message._tag) {
      case "Chunk":
        if (!pending) return;
        this.send({ _tag: "Ack", requestId: message.requestId });
        if (pending.onChunk) pending.onChunk(message.values ?? []);
        else pending.values.push(...(message.values ?? []));
        return;
      case "Exit": {
        if (!pending) return;
        this.pending.delete(message.requestId!);
        const exit = message.exit;
        if (exit?._tag === "Success") pending.resolve(exit.value);
        else pending.reject(new RpcFailure(describeCause(exit?.cause)));
        return;
      }
      case "Defect":
        log().error(`T3 Code RPC defect: ${redact(JSON.stringify(message.defect)).slice(0, 500)}`);
        return;
      case "ClientProtocolError":
        log().error(`T3 Code RPC protocol error: ${redact(raw).slice(0, 500)}`);
        return;
      default:
        return;
    }
  }
}

interface RpcExitWire {
  _tag: "Success" | "Failure";
  value?: Json;
  cause?: Json;
}

export class UnauthorizedError extends Error {}
export class RpcFailure extends Error {}

function describeCause(cause: Json): string {
  const text = JSON.stringify(cause) ?? "unknown failure";
  const message = /"message":"([^"]+)"/.exec(text)?.[1];
  return message ?? text.slice(0, 300);
}
