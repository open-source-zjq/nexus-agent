/** Pending approval/user-input requests resolved out-of-band by HTTP routes. */

export interface ApprovalRecord {
  id: string;
  threadId: string;
  turnId: string;
  toolName: string;
  summary: string;
  status: "pending" | "allowed" | "denied" | "expired";
  /** Audit timestamp: when the request was created (ISO 8601). */
  createdAt?: string;
  /** Audit timestamp: when the request was decided (ISO 8601). */
  decidedAt?: string;
  /** Optional human/operator-supplied reason recorded with the decision. */
  reason?: string;
}

/**
 * Build a fresh pending approval record, stamping `createdAt`.
 *
 * Ported from the original `domain/approval.js` `createApprovalRequest`: the
 * status starts "pending" and `createdAt` defaults to now when not supplied.
 */
export function createApprovalRequest(input: {
  id: string;
  threadId: string;
  turnId: string;
  toolName: string;
  summary: string;
  createdAt?: string;
}): ApprovalRecord {
  return {
    id: input.id,
    threadId: input.threadId,
    turnId: input.turnId,
    toolName: input.toolName,
    summary: input.summary,
    status: "pending",
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Produce a RESOLVED COPY of an approval record (does not mutate the input).
 *
 * Ported from the original `domain/approval.js` `resolveApprovalRequest`:
 * maps the decision onto allowed/denied, records the optional `reason`, and
 * stamps `decidedAt` (defaulting to now).
 */
export function resolveApprovalRequest(
  request: ApprovalRecord,
  decision: "allow" | "deny",
  reason?: string,
  decidedAt?: string,
): ApprovalRecord {
  return {
    ...request,
    status: decision === "allow" ? "allowed" : "denied",
    // Always include the `reason` key (value undefined when not supplied),
    // matching the original `domain/approval.js` resolveApprovalRequest.
    reason,
    decidedAt: decidedAt ?? new Date().toISOString(),
  };
}

export class InMemoryApprovalGate {
  // Records are kept queryable after a decision (mirrors the original
  // `in-memory-approval-gate.js`, which only drops the pending resolver on
  // decide and leaves the resolved record in the approvals map). The resolver
  // map is the actual "pending" set used to gate undecided requests.
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly resolvers = new Map<string, (decision: "allow" | "deny") => void>();

  request(record: ApprovalRecord): Promise<"allow" | "deny"> {
    // Stamp createdAt if the caller did not (keeps the audit trail complete
    // without disturbing callers that already build records via
    // createApprovalRequest).
    const stamped = record.createdAt ? record : { ...record, createdAt: new Date().toISOString() };
    this.records.set(stamped.id, stamped);
    return new Promise((resolve) => {
      this.resolvers.set(stamped.id, resolve);
    });
  }

  get(id: string): ApprovalRecord | undefined {
    return this.records.get(id);
  }

  /** Approvals still awaiting a decision, optionally scoped to a thread. */
  pending(threadId?: string): ApprovalRecord[] {
    return [...this.records.values()].filter(
      (record) => record.status === "pending" && (!threadId || record.threadId === threadId),
    );
  }

  decide(id: string, decision: "allow" | "deny", reason?: string): boolean {
    const record = this.records.get(id);
    // Look up only the stored approval: if it never existed there is nothing
    // to decide. The record stays present after a decision, so re-deciding an
    // already-resolved approval still returns true (the resolver, if any, is a
    // no-op the second time). Mirrors the original
    // `in-memory-approval-gate.js` decide().
    if (!record) return false;
    // Produce a resolved copy and keep it queryable via get().
    this.records.set(id, resolveApprovalRequest(record, decision, reason));
    const resolver = this.resolvers.get(id);
    this.resolvers.delete(id);
    resolver?.(decision);
    return true;
  }

  /** Used by tests to simulate an external decision and tear down the promise. */
  resolve(id: string, decision: "allow" | "deny", reason?: string): boolean {
    return this.decide(id, decision, reason);
  }
}

export interface UserInputResolution {
  status: "submitted" | "cancelled";
  answers?: Record<string, string>;
  text?: string;
}

export interface UserInputRecord {
  id: string;
  threadId: string;
  turnId: string;
  /** Item the request is attached to; forwarded onto the resolved event. */
  itemId?: string;
  /** Prompt shown to the user; forwarded onto the resolved event. */
  prompt?: string;
}

export class InMemoryUserInputGate {
  private readonly pending = new Map<
    string,
    { record: UserInputRecord; resolve: (resolution: UserInputResolution) => void; reject: (reason: unknown) => void }
  >();

  request(record: UserInputRecord): Promise<UserInputResolution> {
    return new Promise((resolve, reject) => {
      this.pending.set(record.id, { record, resolve, reject });
    });
  }

  get(id: string): UserInputRecord | undefined {
    return this.pending.get(id)?.record;
  }

  resolve(id: string, resolution: UserInputResolution): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(resolution);
    return true;
  }

  reset(): void {
    // Faithful to the original `in-memory-user-input-gate.js` reset(): reject
    // each pending promise with the exact error message and clear all state.
    for (const entry of this.pending.values()) entry.reject(new Error("user input gate reset"));
    this.pending.clear();
  }
}
