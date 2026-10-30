export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export interface IdGenerator {
  next(): string;
}

export class RandomIdGenerator implements IdGenerator {
  next(): string {
    return crypto.randomUUID();
  }
}

export class SequenceIdGenerator implements IdGenerator {
  private index = 0;

  constructor(private readonly values: readonly string[]) {}

  next(): string {
    const value = this.values[this.index++];
    if (!value) throw new Error("ID sequence exhausted");
    return value;
  }
}

export async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
