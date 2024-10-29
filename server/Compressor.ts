import Uint8ArrayExtension from '@quentinadam/uint8array-extension';
import EventEmitter from './EventEmitter.ts';

export default class Compressor {
  readonly #writer;
  readonly onData = new EventEmitter<[buffer: Uint8Array]>();

  constructor() {
    const stream = new CompressionStream('gzip');
    this.#writer = stream.writable.getWriter();
    (async () => {
      const reader = stream.readable.getReader();
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        this.onData.emit(Uint8ArrayExtension.concat([new Uint8Array([1]), result.value]));
      }
    })();
  }

  async write(buffer: Uint8Array) {
    this.onData.emit(Uint8ArrayExtension.concat([
      new Uint8Array([0]),
      Uint8ArrayExtension.fromUint32BE(buffer.length),
    ]));
    await this.#writer.write(buffer);
  }
}
