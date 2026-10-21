import { vi } from 'vitest';

/** A stand-in for the browser's EventSource that a test drives by hand. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly withCredentials: boolean;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }

  fail(): void {
    this.onerror?.();
  }

  static install(): void {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  }

  static get last(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (last === undefined) throw new Error('no EventSource was opened');
    return last;
  }
}
