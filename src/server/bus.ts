import { EventEmitter } from 'node:events';

/** In-process change notifications per departure; SSE clients refetch seat state when notified. */
export class Bus {
  private readonly emitter = new EventEmitter();
  private readonly versions = new Map<string, number>();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  version(departureId: string): number {
    return this.versions.get(departureId) ?? 0;
  }

  publish(departureId: string): void {
    const v = this.version(departureId) + 1;
    this.versions.set(departureId, v);
    this.emitter.emit(departureId, v);
  }

  subscribe(departureId: string, cb: (version: number) => void): () => void {
    this.emitter.on(departureId, cb);
    return () => this.emitter.off(departureId, cb);
  }
}
