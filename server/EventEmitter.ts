export default class EventEmitter<T extends Array<unknown>> {
  #listeners = new Set<(...value: T) => void>();

  emit(...value: T) {
    for (const listener of this.#listeners) {
      listener(...value);
    }
  }

  addListener(listener: (...value: T) => void) {
    this.#listeners.add(listener);
    return listener;
  }

  removeListener(listener: (...value: T) => void) {
    this.#listeners.delete(listener);
  }
}
