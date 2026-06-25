/** Injectable id generator port. Ids are `${prefix}_${random}`. */
export interface IdGenerator {
  next(prefix: string): string;
}

/**
 * Default id generator: `${prefix}_${random().toString(36).slice(2, 10)}`,
 * an 8-char base36 suffix. The random source is injectable (defaults to
 * `Math.random`) so tests can produce deterministic ids.
 */
export class RandomIdGenerator implements IdGenerator {
  private readonly random: () => number;

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  next(prefix: string): string {
    return `${prefix}_${this.random().toString(36).slice(2, 10)}`;
  }
}

export const randomIds = new RandomIdGenerator();
