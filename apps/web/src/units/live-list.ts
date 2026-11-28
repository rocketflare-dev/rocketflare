/**
 * A read-only array whose elements are read from its sources on every access, never at import.
 *
 * The unit lists join two barrels — the plugins' and the app's domains — and both sit on an
 * import cycle by design: every plugin and every domain imports `@/plugins/api`, which reaches
 * modules (the ability builder, the registries) that read the unit list. A plugin barrel survives
 * that because its consumers read the live binding at CALL time. A list joined at module scope
 * would read one of the two barrels while it is still evaluating and crash at import with
 * `undefined.map`. Joining on access keeps the barrels' live-binding behaviour exactly, including
 * for a test that swaps the installed set (`tests/helpers/server-plugins.ts`).
 *
 * Every array read works — iteration, spread, `length`, index access and the methods — because the
 * proxy forwards to the joined array. Nothing may write to it. The join is a handful of objects;
 * `build` keeps each unit's identity stable (`units/server.ts`).
 */
export function liveList<T>(build: () => readonly T[]): readonly T[] {
  const real = () => build() as T[]
  return new Proxy([] as T[], {
    get(_target, key) {
      const list = real()
      const value = Reflect.get(list, key, list)
      return typeof value === 'function' ? value.bind(list) : value
    },
    has: (_target, key) => Reflect.has(real(), key),
    ownKeys: () => Reflect.ownKeys(real()),
    getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(real(), key),
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
  })
}
