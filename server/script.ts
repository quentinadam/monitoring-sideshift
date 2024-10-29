import require from 'jsr:@quentinadam/require';
import Decompressor from './Decompressor.ts';

function replaceTimestamp(string: string) {
  return string.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, (string) => {
    const date = new Date(string);
    return [
      date.getDate().toString().padStart(2, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getFullYear().toString().padStart(2, '0'),
    ].join('/') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':');
  });
}

const url = location.href.replace('http', 'ws');
(async () => {
  while (true) {
    const start = Date.now();
    await new Promise<void>((resolve) => {
      const webSocket = new WebSocket(url);
      webSocket.onopen = () => {
        const decompressor = new Decompressor();
        decompressor.onData.addListener((buffer) => {
          const content = new TextDecoder().decode(buffer);
          const root = require(document.getElementById('root'));
          root.innerHTML = replaceTimestamp(content);
        });
        webSocket.onmessage = (e) => {
          decompressor.write(e.data);
        };
      };
      webSocket.onclose = () => {
        resolve();
      };
    });
    await new Promise((resolve) => setTimeout(resolve, start + 5000 - Date.now()));
  }
})();
