/** Buffers user text sent mid-turn, drained at safe boundaries by the agent loop. */
export class SteeringQueue {
  private buffer: string[] = [];
  private turnId: string | null = null;

  setTurn(turnId: string): void {
    if (turnId !== this.turnId) {
      this.buffer = [];
      this.turnId = turnId;
    }
  }

  enqueue(turnId: string, text: string): void {
    if (turnId !== this.turnId) {
      this.buffer = [];
      this.turnId = turnId;
    }
    const trimmed = text.trim();
    if (trimmed.length > 0) this.buffer.push(trimmed);
  }

  drain(): string[] {
    const copy = [...this.buffer];
    this.buffer = [];
    return copy;
  }

  peek(): string[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
    this.turnId = null;
  }
}
