class Store<T extends Record<string, unknown>> {
  private _data: Partial<T> = {}
  private _defaults: Partial<T>

  constructor({ defaults }: { name?: string; defaults?: Partial<T> } = {}) {
    this._defaults = defaults ?? {}
  }

  get<K extends keyof T>(key: K): T[K] {
    const val = key in this._data ? this._data[key] : this._defaults[key]
    // Return a shallow clone of arrays so callers can't mutate the stored reference
    if (Array.isArray(val)) return [...val] as unknown as T[K]
    return val as T[K]
  }

  set<K extends keyof T>(key: K, value: T[K]): void {
    this._data[key] = value
  }

  delete(key: keyof T): void {
    delete this._data[key]
  }

  clear(): void {
    this._data = {}
  }

  get store(): T {
    return { ...this._defaults, ...this._data } as T
  }

  set store(val: T) {
    this._data = { ...val }
  }
}

export default Store
