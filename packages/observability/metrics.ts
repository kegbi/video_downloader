function metricName(value: string): string {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(value)) throw new Error(`Invalid metric name: ${value}`);
  return value;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, amount = 1): void {
    name = metricName(name);
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  set(name: string, value: number): void {
    this.gauges.set(metricName(name), value);
  }

  get(name: string): number {
    return this.counters.get(name) ?? this.gauges.get(name) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, value] of [...this.counters].sort()) {
      lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
    }
    for (const [name, value] of [...this.gauges].sort()) {
      lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
