import { randomBytes } from "node:crypto";
import { requestFingerprint } from "./opencode-integration.ts";

export type BrowserSessionID = string;
export type CallID = string;

type SessionState = "active" | "settled";
type CallState = "outstanding" | "delivered";

interface SessionRecord<T> {
  id: BrowserSessionID;
  clientSessionId: string;
  session: T;
  createdAt: number;
  lastTouchedAt: number;
  state: SessionState;
  settledAt?: number;
  fingerprints: Set<string>;
  calls: Set<CallID>;
}

export interface CallOwner {
  sessionId: BrowserSessionID;
  clientSessionId: string;
  state: CallState;
  createdAt: number;
}

export interface RetiredCall {
  sessionId: BrowserSessionID;
  clientSessionId: string;
  retiredAt: number;
  reason: string;
}

export interface CorrelationConfig<T = unknown> {
  activeTtlMs?: number;
  settledTtlMs?: number;
  retiredCallTtlMs?: number;
  maxSessions?: number;
  now?: () => number;
  onRetire?: (session: T, reason: string) => void;
}

export type CorrelationKind = "request-retry" | "tool-continuation" | "delivered-replay" | "new";

export interface ResolveCorrelationInput<T> {
  clientSessionId: string;
  rawRequest: unknown;
  currentCallIds: string[];
  start: () => T;
}

export interface CorrelationResolution<T> {
  kind: CorrelationKind;
  sessionId: BrowserSessionID;
  session: T;
}

function opaqueSessionId(): BrowserSessionID {
  return `browser_${randomBytes(18).toString("base64url")}`;
}

export class TurnCorrelationRegistry<T> {
  private readonly sessions = new Map<BrowserSessionID, SessionRecord<T>>();
  private readonly requestOwners = new Map<string, BrowserSessionID>();
  private readonly callOwners = new Map<CallID, CallOwner>();
  private readonly retiredCalls = new Map<CallID, RetiredCall>();
  private readonly activeTtlMs: number;
  private readonly settledTtlMs: number;
  private readonly retiredCallTtlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly onRetire?: (session: T, reason: string) => void;

  constructor(config: CorrelationConfig<T> = {}) {
    this.activeTtlMs = config.activeTtlMs ?? 30 * 60_000;
    this.settledTtlMs = config.settledTtlMs ?? 30 * 60_000;
    this.retiredCallTtlMs = config.retiredCallTtlMs ?? 30 * 60_000;
    this.maxSessions = config.maxSessions ?? 256;
    this.now = config.now ?? Date.now;
    this.onRetire = config.onRetire;
    for (const [label, value] of [
      ["activeTtlMs", this.activeTtlMs],
      ["settledTtlMs", this.settledTtlMs],
      ["retiredCallTtlMs", this.retiredCallTtlMs],
      ["maxSessions", this.maxSessions],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
    }
  }

  resolve(input: ResolveCorrelationInput<T>): CorrelationResolution<T> {
    this.prune();
    if (!input.clientSessionId) throw new Error("clientSessionId is required");
    const fingerprint = requestFingerprint(input.clientSessionId, input.rawRequest);

    const retryOwner = this.requestOwners.get(fingerprint);
    if (retryOwner) {
      const record = this.requireSession(retryOwner, input.clientSessionId);
      this.touch(record);
      return { kind: "request-retry", sessionId: record.id, session: record.session };
    }

    const uniqueCallIds = [...new Set(input.currentCallIds)];
    if (uniqueCallIds.length !== input.currentCallIds.length) {
      throw new Error("current OpenCode round contains duplicate call_id values");
    }

    const outstanding: Array<[CallID, CallOwner]> = [];
    const delivered: Array<[CallID, CallOwner]> = [];
    const unknown: CallID[] = [];
    for (const callId of uniqueCallIds) {
      const owner = this.callOwners.get(callId);
      if (owner) {
        if (owner.clientSessionId !== input.clientSessionId) {
          throw new Error(`call_id ${callId} belongs to a different OpenCode session`);
        }
        (owner.state === "outstanding" ? outstanding : delivered).push([callId, owner]);
        continue;
      }
      const retired = this.retiredCalls.get(callId);
      if (retired) {
        throw new Error(`call_id ${callId} was retired (${retired.reason}); start a fresh OpenCode provider round`);
      }
      unknown.push(callId);
    }

    const known = outstanding.length > 0 ? outstanding : delivered;
    if (known.length > 0) {
      if (unknown.length > 0) {
        throw new Error(`continuation mixes known and unknown call_id values: ${unknown.join(", ")}`);
      }
      const sessionIds = new Set([...outstanding, ...delivered].map(([, owner]) => owner.sessionId));
      if (sessionIds.size !== 1) throw new Error("current tool-result batch spans multiple browser sessions");
      const sessionId = [...sessionIds][0]!;
      const record = this.requireSession(sessionId, input.clientSessionId);
      this.bindFingerprint(record, fingerprint);
      this.touch(record);
      return {
        kind: outstanding.length > 0 ? "tool-continuation" : "delivered-replay",
        sessionId: record.id,
        session: record.session,
      };
    }

    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`ChatGPT web correlation registry is full (${this.maxSessions} sessions)`);
    }
    const now = this.now();
    const id = opaqueSessionId();
    const record: SessionRecord<T> = {
      id,
      clientSessionId: input.clientSessionId,
      session: input.start(),
      createdAt: now,
      lastTouchedAt: now,
      state: "active",
      fingerprints: new Set(),
      calls: new Set(),
    };
    this.sessions.set(id, record);
    this.bindFingerprint(record, fingerprint);
    return { kind: "new", sessionId: id, session: record.session };
  }

  bindCalls(sessionId: BrowserSessionID, clientSessionId: string, callIds: string[]): void {
    this.prune();
    const record = this.requireSession(sessionId, clientSessionId);
    if (record.state !== "active") throw new Error("cannot bind new tool calls to a settled browser session");
    for (const callId of callIds) {
      if (!callId) throw new Error("call_id is required");
      if (this.callOwners.has(callId) || this.retiredCalls.has(callId)) {
        throw new Error(`duplicate or retired ChatGPT bridge call_id: ${callId}`);
      }
    }
    const now = this.now();
    for (const callId of callIds) {
      this.callOwners.set(callId, { sessionId, clientSessionId, state: "outstanding", createdAt: now });
      record.calls.add(callId);
    }
    this.touch(record);
  }

  markDelivered(sessionId: BrowserSessionID, clientSessionId: string, callId: CallID): void {
    this.prune();
    const record = this.requireSession(sessionId, clientSessionId);
    const owner = this.callOwners.get(callId);
    if (!owner || owner.sessionId !== sessionId || owner.clientSessionId !== clientSessionId) {
      throw new Error(`tool result does not match an owned call_id: ${callId}`);
    }
    if (owner.state === "delivered") throw new Error(`tool result was already delivered: ${callId}`);
    owner.state = "delivered";
    this.touch(record);
  }

  settleSession(sessionId: BrowserSessionID, clientSessionId: string): void {
    this.prune();
    const record = this.requireSession(sessionId, clientSessionId);
    const now = this.now();
    record.state = "settled";
    record.settledAt = now;
    record.lastTouchedAt = now;
  }

  abortSession(sessionId: BrowserSessionID, clientSessionId: string, reason = "client abort"): T | undefined {
    this.prune();
    const record = this.sessions.get(sessionId);
    if (!record) return undefined;
    if (record.clientSessionId !== clientSessionId) throw new Error("browser session belongs to a different OpenCode session");
    this.retireRecord(record, reason);
    return record.session;
  }

  ownerOf(callId: string): CallOwner | undefined {
    this.prune();
    const owner = this.callOwners.get(callId);
    return owner ? { ...owner } : undefined;
  }

  counts(): { sessions: number; activeSessions: number; settledSessions: number; calls: number; retiredCalls: number } {
    this.prune();
    let activeSessions = 0;
    let settledSessions = 0;
    for (const record of this.sessions.values()) {
      if (record.state === "active") activeSessions += 1;
      else settledSessions += 1;
    }
    return {
      sessions: this.sessions.size,
      activeSessions,
      settledSessions,
      calls: this.callOwners.size,
      retiredCalls: this.retiredCalls.size,
    };
  }

  clear(reason = "registry cleared"): T[] {
    this.prune();
    const records = [...this.sessions.values()];
    for (const record of records) this.retireRecord(record, reason);
    return records.map(record => record.session);
  }

  private bindFingerprint(record: SessionRecord<T>, fingerprint: string): void {
    const current = this.requestOwners.get(fingerprint);
    if (current && current !== record.id) throw new Error("request fingerprint collision across browser sessions");
    this.requestOwners.set(fingerprint, record.id);
    record.fingerprints.add(fingerprint);
  }

  private requireSession(sessionId: BrowserSessionID, clientSessionId: string): SessionRecord<T> {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`browser session is no longer available: ${sessionId}`);
    if (record.clientSessionId !== clientSessionId) throw new Error("browser session belongs to a different OpenCode session");
    return record;
  }

  private touch(record: SessionRecord<T>): void {
    record.lastTouchedAt = this.now();
  }

  private retireRecord(record: SessionRecord<T>, reason: string): void {
    this.sessions.delete(record.id);
    for (const fingerprint of record.fingerprints) {
      if (this.requestOwners.get(fingerprint) === record.id) this.requestOwners.delete(fingerprint);
    }
    const now = this.now();
    for (const callId of record.calls) {
      const owner = this.callOwners.get(callId);
      if (owner?.sessionId === record.id) this.callOwners.delete(callId);
      this.retiredCalls.set(callId, {
        sessionId: record.id,
        clientSessionId: record.clientSessionId,
        retiredAt: now,
        reason,
      });
    }
    this.onRetire?.(record.session, reason);
  }

  private prune(): void {
    const now = this.now();
    for (const record of [...this.sessions.values()]) {
      if (record.state === "active" && now - record.createdAt >= this.activeTtlMs) {
        this.retireRecord(record, "active turn TTL expired");
        continue;
      }
      if (record.state === "settled" && record.settledAt !== undefined && now - record.settledAt >= this.settledTtlMs) {
        this.retireRecord(record, "settled replay TTL expired");
      }
    }
    for (const [callId, retired] of this.retiredCalls) {
      if (now - retired.retiredAt >= this.retiredCallTtlMs) this.retiredCalls.delete(callId);
    }
  }
}
