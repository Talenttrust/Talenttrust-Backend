import { timingSafeEqual } from 'node:crypto';

export type LabelSet = Record<string, string>;

export const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: LabelSet): string {
  const pairs = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`);
  return `{${pairs.join(',')}}`;
}

function canonicalKey(labelNames: string[], labels: LabelSet): string {
  return labelNames.map((name) => labels[name] ?? '').join('\x00');
}

export interface MetricSample {
  name: string;
  labels: LabelSet;
  value: number;
}

export class Counter {
  private entries = new Map<string, { labels: LabelSet; value: number }>();
  constructor(
    public name: string,
    public help: string,
    public labelNames: string[],
  ) {}
  inc(labels: LabelSet, amount = 1): void {
    const key = canonicalKey(this.labelNames, labels);
    const existing = this.entries.get(key);
    if (existing) {
      existing.value += amount;
    } else {
      this.entries.set(key, { labels: { ...labels }, value: amount });
    }
  }
  all(): { labels: LabelSet; value: number }[] {
    return [...this.entries.values()];
  }
  exposition(): MetricSample[] {
    return this.all().map(({ labels, value }) => ({ name: this.name, labels, value }));
  }
}

export class Gauge {
  private entries = new Map<string, { labels: LabelSet; value: number }>();
  constructor(
    public name: string,
    public help: string,
    public labelNames: string[],
  ) {}
  set(labels: LabelSet, value: number): void {
    const key = canonicalKey(this.labelNames, labels);
    this.entries.set(key, { labels: { ...labels }, value });
  }
  all(): { labels: LabelSet; value: number }[] {
    return [...this.entries.values()];
  }
  exposition(): MetricSample[] {
    return this.all().map(({ labels, value }) => ({ name: this.name, labels, value }));
  }
}

export class Histogram {
  private entries = new Map<string, { labels: LabelSet; buckets: Map<string, number>; count: number; sum: number }>();
  constructor(
    public name: string,
    public help: string,
    public labelNames: string[],
    public buckets: number[],
  ) {}
  observe(labels: LabelSet, value: number): void {
    const key = canonicalKey(this.labelNames, labels);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { labels: { ...labels }, buckets: new Map(), count: 0, sum: 0 };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    entry.sum += value;
    for (const le of this.buckets) {
      if (value <= le) {
        entry.buckets.set(String(le), (entry.buckets.get(String(le)) ?? 0) + 1);
      }
    }
    entry.buckets.set('+Inf', (entry.buckets.get('+Inf') ?? 0) + 1);
  }
  exposition(): MetricSample[] {
    const samples: MetricSample[] = [];
    for (const { labels, buckets, count, sum } of this.entries.values()) {
      for (const [le, c] of buckets) {
        samples.push({ name: this.name + '_bucket', labels: { ...labels, le }, value: c });
      }
      samples.push({ name: this.name + '_sum', labels, value: sum });
      samples.push({ name: this.name + '_count', labels, value: count });
    }
    return samples;
  }
}

export class Registry {
  private metrics = new Map<string, { exposition: () => MetricSample[]; type: string; help: string; name: string }>();
  counter(name: string, help: string, labelNames: string[]): Counter {
    const m = new Counter(name, help, labelNames);
    this.metrics.set(name, { exposition: () => m.exposition(), type: 'counter', help, name: m.name });
    return m;
  }
  gauge(name: string, help: string, labelNames: string[]): Gauge {
    const m = new Gauge(name, help, labelNames);
    this.metrics.set(name, { exposition: () => m.exposition(), type: 'gauge', help, name: m.name });
    return m;
  }
  histogram(name: string, help: string, labelNames: string[], buckets: number[]): Histogram {
    const m = new Histogram(name, help, labelNames, buckets);
    this.metrics.set(name, { exposition: () => m.exposition(), type: 'histogram', help, name: m.name });
    return m;
  }
  exposition(): string {
    const lines: string[] = [];
    for (const { name, help, type, exposition } of this.metrics.values()) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      for (const sample of exposition()) {
        lines.push(`${sample.name}${formatLabels(sample.labels)} ${valueToString(sample.value)}`);
      }
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
  }
}

function valueToString(value: number): string {
  return Number.isFinite(value) ? value.toString() : String(value);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function createRegistry(): Registry {
  return new Registry();
}
