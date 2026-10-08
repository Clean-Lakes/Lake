export class ConnectionPool<T> {
  private readonly handles = new Map<string, Promise<T>>();
  async get(key: string, factory: () => Promise<T>): Promise<T> {
    let value = this.handles.get(key);
    if (!value) {
      value = factory();
      this.handles.set(key, value);
      void value.catch(() => this.handles.delete(key));
    }
    return value;
  }
  invalidate(key: string): void {
    this.handles.delete(key);
  }
  async close(close: (handle: T) => void): Promise<void> {
    for (const handle of this.handles.values())
      try {
        close(await handle);
      } catch {}
    this.handles.clear();
  }
}
