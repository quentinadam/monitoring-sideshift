import * as esbuild from 'https://deno.land/x/esbuild@v0.20.0/mod.js';
import { denoPlugins } from 'https://deno.land/x/esbuild_deno_loader@0.9.0/mod.ts';
import Compressor from './Compressor.ts';

type Request =
  & { index: number; timestamp: Date; responseTime: number }
  & ({ success: true; status: number } | { success: false });

type Bucket = {
  label: string;
  count: number;
  fn: (request: Request) => boolean;
  subBuckets: {
    count: number;
    fn: (request: Request) => boolean;
  }[];
  bold?: boolean;
};

const requests = new Array<Request>();
const connections = new Set<{ webSocket: WebSocket; compressor: Compressor; interval?: number }>();

async function request({ index, timestamp }: { index: number; timestamp: Date }) {
  const processResponse = (result: { success: true; status: number } | { success: false }) => {
    const responseTime = Date.now() - timestamp.valueOf();
    console.log([
      new Date().toISOString(),
      (index % 1e6).toString().padStart(6, '0'),
      `${result.success ? result.status : 'error'} returned after ${responseTime}ms`,
    ].join(' '));
    requests.unshift({ index, timestamp, responseTime, ...result });
    requests.sort((a, b) => b.index - a.index);
    if (requests.length > 20000) {
      requests.pop();
    }
    for (const connection of connections) {
      const { webSocket, compressor, interval } = connection;
      const content = generateContent(interval);
      try {
        compressor.write(new TextEncoder().encode(content));
      } catch (_) {
        connections.delete(connection);
        webSocket.close();
      }
    }
  };
  try {
    const response = await fetch('https://sideshift.ai/api/v1/liquidity/tasks');
    processResponse({ success: true, status: response.status });
  } catch (_) {
    processResponse({ success: false });
  }
}

(async () => {
  const interval = 5000;
  let index = 0;
  let timestamp = new Date(Math.ceil(Date.now() / interval) * interval);
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, timestamp.valueOf() - Date.now()));
    request({ index, timestamp });
    index++;
    timestamp = new Date(timestamp.valueOf() + interval);
  }
})();

function generateContent(interval = 3600) {
  return ((requests) => {
    const createSubBuckets = () => {
      return [
        { count: 0, fn: (request: Request) => request.success && request.status === 200 },
        { count: 0, fn: (request: Request) => request.success && request.status === 429 },
        { count: 0, fn: (request: Request) => request.success && request.status === 502 },
        { count: 0, fn: (request: Request) => request.success && request.status === 504 },
        { count: 0, fn: (request: Request) => !request.success },
      ];
    };
    const buckets: Bucket[] = [
      ...Array.from({ length: 5 }).map((_, index) => {
        const minResponseTime = index * 1000;
        const maxResponseTime = (index + 1) * 1000;
        return {
          label: `${minResponseTime}-${maxResponseTime}`,
          count: 0,
          fn: (request: Request) => request.responseTime >= minResponseTime && request.responseTime < maxResponseTime,
          subBuckets: createSubBuckets(),
        };
      }),
      ...Array.from({ length: 5 }).map((_, index) => {
        const minResponseTime = (index + 1) * 5000;
        const maxResponseTime = (index + 2) * 5000;
        return {
          label: `${minResponseTime}-${maxResponseTime}`,
          count: 0,
          fn: (request: Request) => request.responseTime >= minResponseTime && request.responseTime < maxResponseTime,
          subBuckets: createSubBuckets(),
        };
      }),
      {
        label: '30000+',
        count: 0,
        fn: (request: Request) => request.responseTime >= 30000,
        subBuckets: createSubBuckets(),
      },
      {
        label: 'sum',
        count: 0,
        fn: () => true,
        subBuckets: createSubBuckets(),
        bold: true,
      },
    ];
    for (const request of requests) {
      for (const bucket of buckets) {
        if (bucket.fn(request)) {
          bucket.count++;
          for (const subBucket of bucket.subBuckets) {
            if (subBucket.fn(request)) {
              subBucket.count++;
            }
          }
        }
      }
    }
    const createBucketRow = (bucket: Bucket) => {
      const createClass = ({ alignment, bold }: { alignment: string; bold?: boolean }) => {
        return [alignment, ...((bold ?? bucket.bold) === true ? ['bold'] : [])].join(' ');
      };
      const createCell = ({ count, bold }: { count: number; bold?: boolean }) => {
        if (count === 0) {
          return `<td class="${createClass({ alignment: 'right', bold })}" style="color: #999">${count}</td>`;
        } else {
          return `<td class="${createClass({ alignment: 'right', bold })}">${count}</td>`;
        }
      };
      return `<tr>
        <td class="${createClass({ alignment: 'left' })}">${bucket.label}</td>
        ${bucket.subBuckets.map((subBucket) => createCell({ count: subBucket.count })).join('')}
        ${createCell({ count: bucket.count, bold: true })}
      </tr>`;
    };
    const createRequestRow = (request: Request) => {
      return `<tr>
        <td class="left">${request.timestamp.toISOString().slice(0, 19)}Z</td>
        <td class="right">${request.index}</td>
        <td class="right">${request.responseTime}ms</td>
        <td class="right">${request.success ? request.status : 'error'}</td>
      </tr>`;
    };
    return `
      <h1>Summary</h1>
      <table>
        <tr>
          <th class="left">response time</th>
          <th class="right">200</th>
          <th class="right">429</th>
          <th class="right">502</th>
          <th class="right">504</th>
          <th class="right">error</th>
          <th class="right bold">sum</th>
        </tr>
        ${buckets.map((bucket) => createBucketRow(bucket)).join('')}
      </table>
      <h1 style="font-size: 14px">Requests</h1>
      <table>
        <tr>
          <th class="left">timestamp</th>
          <th class="right">index</th>
          <th class="right">response time</th>
          <th class="right">status</th>
        </tr>
        ${requests.map((request) => createRequestRow(request)).join('')}
      </table>
    `;
  })(requests.filter((request) => Date.now() - request.timestamp.valueOf() <= interval * 1000));
}

async function compileScript() {
  const result = await esbuild.build({
    plugins: [...denoPlugins()],
    entryPoints: ['./script.ts'],
    write: false,
    bundle: true,
    format: 'esm',
  });
  esbuild.stop();
  return result.outputFiles[0].text;
}

Deno.serve({ port: 80, hostname: '0.0.0.0' }, async (request) => {
  const url = new URL(request.url);
  console.log(`${request.method} ${url.pathname}${url.search}`);
  if (request.method !== 'GET' || url.pathname !== '/') {
    return new Response('Not Found', { status: 404 });
  }
  const interval = ((interval) => {
    return (interval !== null) ? ((interval) => isNaN(interval) ? undefined : interval)(parseInt(interval)) : undefined;
  })(url.searchParams.get('interval'));
  if (request.headers.get('upgrade') === 'websocket') {
    const { response, socket: webSocket } = Deno.upgradeWebSocket(request);
    webSocket.onopen = () => {
      const compressor = new Compressor();
      const connection = { webSocket, compressor, interval };
      connections.add(connection);
      compressor.onData.addListener((buffer) => {
        webSocket.send(buffer);
      });
      const content = generateContent(interval);
      compressor.write(new TextEncoder().encode(content));
      webSocket.onclose = () => {
        connections.delete(connection);
      };
    };
    return response;
  }
  const script = await compileScript();
  const html = `<!DOCTYPE html>
    <html>
    <head>
    <title>Monitoring</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Nunito+Sans:ital,opsz,wght@0,6..12,200..1000;1,6..12,200..1000&display=swap" rel="stylesheet">
    <style>
      * {
        font-family: "Nunito Sans", serif;
        font-size: 12px;
        margin: 0px;
        padding: 0px;
      }
      td, th {
        padding: 2px 4px;
      }
      td.bold, th.bold {
        font-weight: bold;
      }
      td.left, th.left {
        text-align: left;
      }
      td.right, th.right {
        text-align: right;
      }
      table {
        width: 100%;
        border-spacing: 0px;
        margin: 0 -4px;
      }
      h1 {
        font-size: 14px;
        margin: 12px 0 4px 0;
      }
    </style>
    <script>${script}</script>
    </head>
    <body style="padding: 0 16px">
    <div id="root" style="max-width: 400px; margin: 0px auto">Loading</div>
    </body>
    </html>`;
  return new Response(html, { headers: { 'Content-type': 'text/html ' } });
});
