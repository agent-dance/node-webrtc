export interface RTCStats {
  id: string;
  type: string;
  timestamp: number;
}

export type RTCStatsReport = RTCStatsReportImpl;

export class RTCStatsReportImpl {
  private readonly _map: Map<string, RTCStats>;

  constructor(map: Map<string, RTCStats>) {
    this._map = map;
  }

  entries(): IterableIterator<[string, RTCStats]> {
    return this._map.entries();
  }

  get(id: string): RTCStats | undefined {
    return this._map.get(id);
  }

  has(id: string): boolean {
    return this._map.has(id);
  }

  forEach(callbackfn: (value: RTCStats, key: string) => void): void {
    this._map.forEach(callbackfn);
  }

  [Symbol.iterator](): IterableIterator<[string, RTCStats]> {
    return this._map.entries();
  }
}
