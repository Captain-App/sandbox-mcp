// src/realtime/channel.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RealtimeChannel } from "./channel";

describe("RealtimeChannel", () => {
  let ctx: any;
  let env: any;
  let storage: any;

  beforeEach(() => {
    storage = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn().mockResolvedValue(new Map()),
      getAlarm: vi.fn().mockResolvedValue(null),
      setAlarm: vi.fn(),
    };

    ctx = {
      id: { toString: () => "test-session" },
      storage,
      blockConcurrencyWhile: vi.fn((cb) => cb()),
      acceptWebSocket: vi.fn(),
      getWebSockets: vi.fn().mockReturnValue([]),
    };

    env = {};
  });

  it("should initialize sequence from storage", async () => {
    storage.get.mockResolvedValueOnce(42);
    new RealtimeChannel(ctx, env);

    // Check that it tried to get seq
    expect(storage.get).toHaveBeenCalledWith("seq");
  });

  it("should publish and broadcast events", async () => {
    const channel = new RealtimeChannel(ctx, env);
    const ws = { send: vi.fn() };
    ctx.getWebSockets.mockReturnValue([ws]);

    const request = new Request("http://localhost/publish", {
      method: "POST",
      body: JSON.stringify({ type: "test", data: { foo: "bar" } }),
    });

    const response = await channel.fetch(request);
    const result = (await response.json()) as any;

    expect(result.success).toBe(true);
    expect(result.event.type).toBe("test");
    expect(result.event.seq).toBe(1);

    // Should have stored event
    expect(storage.put).toHaveBeenCalledWith("event:1", expect.any(Object));
    expect(storage.put).toHaveBeenCalledWith("seq", 1);

    // Should have broadcast to WS
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(result.event));
  });

  it("should replay missed events on connection", async () => {
    storage.get.mockResolvedValueOnce(10); // seq = 10
    const channel = new RealtimeChannel(ctx, env);

    const event = { seq: 5, type: "old", timestamp: 123, sessionId: "test", data: {} };
    storage.list.mockResolvedValueOnce(new Map([["event:5", event]]));

    const ws = { send: vi.fn() };
    // We can't easily test the fetch upgrade here because it requires WebSocketPair
    // but we can test the internal handleWebSocket
    await (channel as any).handleWebSocket(ws, 4);

    expect(ctx.acceptWebSocket).toHaveBeenCalledWith(ws);
    expect(storage.list).toHaveBeenCalledWith(
      expect.objectContaining({
        start: "event:5",
      }),
    );
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(event));
  });

  it("should prune old events from replay buffer", async () => {
    const channel = new RealtimeChannel(ctx, env);
    // Buffer size is 100
    (channel as any).seq = 100;

    await (channel as any).publish("test", {});

    // Should delete event:1 when seq becomes 101
    expect(storage.delete).toHaveBeenCalledWith("event:1");
  });
});
