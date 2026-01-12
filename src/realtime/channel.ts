// src/realtime/channel.ts
import { DurableObject } from "cloudflare:workers";
import { RealtimeEvent, PublishRequest } from "./types";

/**
 * RealtimeChannel Durable Object
 *
 * Manages WebSocket connections for a single session (channel) and
 * provides a broadcast mechanism for real-time events.
 *
 * Key features:
 * - WebSocket hibernation for efficient scaling
 * - Replay buffer (last 100 events) in DO storage
 * - Monotonic sequence numbers per channel
 */
export class RealtimeChannel extends DurableObject<Env> {
  private seq = 0;
  private readonly REPLAY_BUFFER_SIZE = 100;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Initialize sequence from storage if available
    this.ctx.blockConcurrencyWhile(async () => {
      const storedSeq = await this.ctx.storage.get<number>("seq");
      if (storedSeq !== undefined) {
        this.seq = storedSeq;
      }

      // Schedule first heartbeat
      await this.scheduleHeartbeat();
    });
  }

  /**
   * Schedule the next heartbeat alarm
   */
  private async scheduleHeartbeat() {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) {
      // Ping every 30 seconds
      await this.ctx.storage.setAlarm(Date.now() + 30000);
    }
  }

  /**
   * Alarm handler for heartbeats
   */
  async alarm() {
    const websockets = this.ctx.getWebSockets();
    for (const ws of websockets) {
      try {
        // Send a ping frame (using text "ping" as our protocol)
        ws.send("ping");
      } catch {
        ws.close(1011, "Ping failed");
      }
    }

    // Reschedule
    await this.ctx.storage.setAlarm(Date.now() + 30000);
  }

  /**
   * Handle incoming HTTP requests to the DO.
   * - GET /: WebSocket upgrade
   * - POST /publish: Publish a new event to the channel
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade request
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Extract lastSeq from query params for replay
      const lastSeq = parseInt(url.searchParams.get("lastSeq") || "-1");

      // Handle the WebSocket server-side
      await this.handleWebSocket(server, lastSeq);

      return new Response(null, { status: 101, webSocket: client });
    }

    // Publish event request (internal)
    if (request.method === "POST" && url.pathname === "/publish") {
      try {
        const body = (await request.json()) as PublishRequest;
        const event = await this.publish(body.type, body.data);
        return Response.json({ success: true, event });
      } catch (e: any) {
        return Response.json({ success: false, error: e.message }, { status: 400 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * Handle WebSocket connection
   */
  private async handleWebSocket(ws: WebSocket, lastSeq: number) {
    // Accept the WebSocket with hibernation
    this.ctx.acceptWebSocket(ws);

    // Replay missed events if requested
    if (lastSeq >= 0 && lastSeq < this.seq) {
      const events = await this.getEventsAfter(lastSeq);
      for (const event of events) {
        ws.send(JSON.stringify(event));
      }
    }
  }

  /**
   * Publish a new event to the channel
   */
  private async publish(type: string, data: any): Promise<RealtimeEvent> {
    this.seq++;
    const sessionId = this.ctx.id.toString();
    const event: RealtimeEvent = {
      seq: this.seq,
      type,
      timestamp: Date.now(),
      sessionId,
      data,
    };

    // Store in replay buffer
    await this.ctx.storage.put(`event:${this.seq}`, event);
    await this.ctx.storage.put("seq", this.seq);

    // Prune old events (fire and forget)
    if (this.seq > this.REPLAY_BUFFER_SIZE) {
      this.ctx.storage.delete(`event:${this.seq - this.REPLAY_BUFFER_SIZE}`);
    }

    // Broadcast to all connected clients
    this.broadcast(event);

    return event;
  }

  /**
   * Broadcast event to all connected WebSockets
   */
  private broadcast(event: RealtimeEvent) {
    const message = JSON.stringify(event);
    const websockets = this.ctx.getWebSockets();
    for (const ws of websockets) {
      try {
        ws.send(message);
      } catch {
        // Socket might be closing/closed
      }
    }
  }

  /**
   * Retrieve events from storage for replay
   */
  private async getEventsAfter(lastSeq: number): Promise<RealtimeEvent[]> {
    const start = lastSeq + 1;
    const end = this.seq;

    // Durable Object list can fetch a range of keys
    const entries = await this.ctx.storage.list<RealtimeEvent>({
      start: `event:${start}`,
      end: `event:${end + 1}`,
      limit: this.REPLAY_BUFFER_SIZE,
    });

    return Array.from(entries.values());
  }

  /**
   * WebSocket message handler (hibernation API)
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // We don't expect much from the client yet, but we could handle
    // heartbeats or explicit replay requests here.
    if (message === "ping") {
      ws.send("pong");
    }
  }

  /**
   * WebSocket close handler
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean) {
    ws.close(code, reason);
  }

  /**
   * WebSocket error handler
   */
  async webSocketError(ws: WebSocket, error: any) {
    console.error("WebSocket error:", error);
  }
}
