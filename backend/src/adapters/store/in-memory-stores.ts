import type { Thread, ThreadSummary } from "../../contracts/threads.js";
import type { TurnItem } from "../../contracts/items.js";
import type { RuntimeEvent } from "../../contracts/events.js";
import type { SessionStore, ThreadStore, ListThreadsOptions, SessionRecord } from "./types.js";
import { toThreadSummary, matchesThreadFilter } from "./summary.js";

export class InMemoryThreadStore implements ThreadStore {
  private readonly threads = new Map<string, Thread>();

  async get(id: string): Promise<Thread | null> {
    return this.threads.get(id) ?? null;
  }

  async upsert(thread: Thread): Promise<void> {
    this.threads.set(thread.id, thread);
  }

  async list(options?: ListThreadsOptions): Promise<ThreadSummary[]> {
    const all = [...this.threads.values()]
      .filter((thread) => thread.status !== "deleted")
      .filter((thread) => matchesThreadFilter(thread, options))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map(toThreadSummary);
    return options?.limit ? all.slice(0, options.limit) : all;
  }

  async delete(id: string): Promise<boolean> {
    return this.threads.delete(id);
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly events = new Map<string, RuntimeEvent[]>();
  private readonly items = new Map<string, TurnItem[]>();
  private readonly sessions = new Map<string, SessionRecord>();

  async appendEvent(threadId: string, event: RuntimeEvent): Promise<void> {
    const list = this.events.get(threadId) ?? [];
    if (list.some((existing) => existing.seq === event.seq)) return;
    list.push(event);
    this.events.set(threadId, list);
    const session = this.sessions.get(threadId);
    if (session) {
      this.sessions.set(threadId, {
        ...session,
        events: [...session.events, event],
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async appendItem(threadId: string, item: TurnItem): Promise<void> {
    const list = this.items.get(threadId) ?? [];
    const existingIndex = list.findIndex((existing) => existing.id === item.id);
    const nextList = existingIndex >= 0 ? list.map((existing) => (existing.id === item.id ? item : existing)) : [...list, item];
    this.items.set(threadId, nextList);
    const session = this.sessions.get(threadId);
    if (session) {
      this.sessions.set(threadId, {
        ...session,
        items: existingIndex >= 0 ? session.items.map((existing) => (existing.id === item.id ? item : existing)) : [...session.items, item],
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async updateItem(threadId: string, itemId: string, patch: Partial<TurnItem>): Promise<TurnItem | null> {
    const list = this.items.get(threadId) ?? [];
    let updated: TurnItem | null = null;
    const nextList = list.map((item) => {
      if (item.id !== itemId) return item;
      updated = { ...item, ...patch } as TurnItem;
      return updated;
    });
    if (!updated) return null;
    this.items.set(threadId, nextList);
    const session = this.sessions.get(threadId);
    if (session) {
      this.sessions.set(threadId, {
        ...session,
        items: nextList,
        updatedAt: new Date().toISOString(),
      });
    }
    return updated;
  }

  async rewriteItems(threadId: string, items: TurnItem[]): Promise<void> {
    const nextItems = [...items];
    this.items.set(threadId, nextItems);
    const session = this.sessions.get(threadId);
    if (session) {
      this.sessions.set(threadId, {
        ...session,
        items: nextItems,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async loadItems(threadId: string): Promise<TurnItem[]> {
    return [...(this.items.get(threadId) ?? [])];
  }

  async loadEventsSince(threadId: string, sinceSeq: number): Promise<RuntimeEvent[]> {
    return (this.events.get(threadId) ?? []).filter((event) => event.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  }

  async loadSession(threadId: string): Promise<SessionRecord | null> {
    return this.sessions.get(threadId) ?? null;
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.threadId, session);
    if (!this.events.has(session.threadId)) {
      this.events.set(session.threadId, [...session.events]);
    }
    if (!this.items.has(session.threadId)) {
      this.items.set(session.threadId, [...session.items]);
    }
  }

  async highestSeq(threadId: string): Promise<number> {
    return (this.events.get(threadId) ?? []).reduce((max, event) => Math.max(max, event.seq), 0);
  }

  async resetMemory(): Promise<void> {
    this.events.clear();
    this.items.clear();
    this.sessions.clear();
  }
}
