import Uint8ArrayExtension from 'jsr:@quentinadam/uint8array-extension';
import assert from 'jsr:@quentinadam/assert';
import EventEmitter from './EventEmitter.ts';

export default class Decompressor {
  readonly #writer;
  readonly onData = new EventEmitter<[buffer: Uint8Array]>();
  readonly #lengths = new Array<number>();
  #buffer = new Uint8Array(0);

  constructor() {
    const stream = new DecompressionStream('gzip');
    this.#writer = stream.writable.getWriter();
    (async () => {
      const reader = stream.readable.getReader();
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        this.#buffer = Uint8ArrayExtension.concat([this.#buffer, result.value]);
        assert(this.#lengths.length > 0);
        const length = this.#lengths[0];
        if (this.#buffer.length >= length) {
          const buffer = this.#buffer.slice(0, length);
          this.#buffer = this.#buffer.slice(length);
          this.onData.emit(buffer);
          this.#lengths.shift();
        }
      }
    })();
  }

  async write(blob: Blob) {
    const buffer = new Uint8Array(await blob.arrayBuffer());
    if (buffer[0] === 0 && buffer.length === 5) {
      const length = new Uint8ArrayExtension(buffer).getUint32BE(1);
      this.#lengths.push(length);
    } else {
      assert(buffer[0] === 1);
      await this.#writer.write(buffer.slice(1));
    }
  }
}
