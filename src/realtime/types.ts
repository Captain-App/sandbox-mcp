// src/realtime/types.ts

export interface RealtimeEvent {
  seq: number; // Monotonic sequence
  type: string; // Event type (from OpenCode or custom)
  timestamp: number; // Unix ms
  sessionId: string;
  data: any; // Event payload
}

export interface PublishRequest {
  type: string;
  data: any;
}
