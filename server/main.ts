import * as esbuild from 'https://deno.land/x/esbuild@v0.20.0/mod.js';
import { denoPlugins } from 'https://deno.land/x/esbuild_deno_loader@0.9.0/mod.ts';
import Compressor from './Compressor.ts';

type Response = { timestamp: Date } & ({ success: true; status: number; ray?: string } | { success: false });

type Request = {
  request: { timestamp: Date };
  response?: Response;
};

type Bucket = {
  label: string;
  count: number;
  fn: (request: Request) => boolean;
  subBuckets: {
    count: number;
    fn: (response: Response) => boolean;
  }[];
  bold?: boolean;
};

const requests = new Array<Request>();
const connections = new Set<{ webSocket: WebSocket; compressor: Compressor; interval?: number }>();

function update() {
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
}

async function request({ timestamp }: { timestamp: Date }) {
  const request: Request = { request: { timestamp } };
  requests.unshift(request);
  if (requests.length > 20000) {
    requests.pop();
  }
  update();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 60000);
  const processResponse = (result: { success: true; status: number; ray?: string } | { success: false }) => {
    clearTimeout(timer);
    request.response = { timestamp: new Date(), ...result };
    update();
  };
  try {
    const response = await fetch('https://sideshift.ai/api/v1/liquidity/tasks', { signal: controller.signal });
    const ray = response.headers.get('cf-ray');
    processResponse({ success: true, status: response.status, ray: ray !== null ? ray : undefined });
  } catch (_) {
    processResponse({ success: false });
  }
}

(async () => {
  const interval = 5000;
  let timestamp = new Date(Math.ceil(Date.now() / interval) * interval);
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, timestamp.valueOf() - Date.now()));
    request({ timestamp });
    timestamp = new Date(timestamp.valueOf() + interval);
  }
})();

function generateContent(interval = 3600) {
  return ((requests) => {
    const createSubBuckets = () => {
      return [
        { count: 0, fn: (response: Response) => response.success && response.status === 200 },
        { count: 0, fn: (response: Response) => response.success && response.status === 429 },
        { count: 0, fn: (response: Response) => response.success && response.status === 502 },
        { count: 0, fn: (response: Response) => response.success && response.status === 504 },
        { count: 0, fn: (response: Response) => !response.success },
      ];
    };
    const createBucket = (
      { minResponseTime, maxResponseTime }: { minResponseTime: number; maxResponseTime?: number },
    ) => {
      return {
        label: maxResponseTime !== undefined ? `${minResponseTime}-${maxResponseTime}` : `${minResponseTime}+`,
        count: 0,
        fn: ({ request, response }: Request) => {
          if (response === undefined) {
            return false;
          }
          const responseTime = response.timestamp.valueOf() - request.timestamp.valueOf();
          if (maxResponseTime !== undefined) {
            return responseTime >= minResponseTime && responseTime < maxResponseTime;
          } else {
            return responseTime >= minResponseTime;
          }
        },
        subBuckets: createSubBuckets(),
      };
    };
    const buckets: Bucket[] = [
      ...Array.from({ length: 5 }).map((_, index) => {
        const minResponseTime = index * 1000;
        const maxResponseTime = (index + 1) * 1000;
        return createBucket({ minResponseTime, maxResponseTime });
      }),
      ...Array.from({ length: 5 }).map((_, index) => {
        const minResponseTime = (index + 1) * 5000;
        const maxResponseTime = (index + 2) * 5000;
        return createBucket({ minResponseTime, maxResponseTime });
      }),
      createBucket({ minResponseTime: 30000 }),
      {
        label: 'sum',
        count: 0,
        fn: (request) => request.response !== undefined,
        subBuckets: createSubBuckets(),
        bold: true,
      },
    ];
    for (const request of requests) {
      for (const bucket of buckets) {
        if (bucket.fn(request)) {
          bucket.count++;
          for (const subBucket of bucket.subBuckets) {
            if (request.response !== undefined && subBucket.fn(request.response)) {
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
    const createRequestRow = ({ request, response }: Request) => {
      if (response !== undefined) {
        const responseTime = response.timestamp.valueOf() - request.timestamp.valueOf();
        return `<tr>
          <td class="left">${request.timestamp.toISOString().slice(0, 19)}Z</td>
          <td class="right">${responseTime}ms</td>
          <td class="right">${response.success ? response.status : 'error'}</td>
          <td class="right" style="font-family: Roboto Mono; font-size: 11px">${
          response.success ? response.ray : ''
        }</td>
        </tr>`;
      } else {
        return `<tr>
          <td class="left">${request.timestamp.toISOString().slice(0, 19)}Z</td>
          <td class="right"><span class="ellipsis">•</span><span class="ellipsis">•</span><span class="ellipsis">•</span></td>
          <td class="right"><span class="ellipsis">•</span><span class="ellipsis">•</span><span class="ellipsis">•</span></td>
          <td class="right"><span class="ellipsis">•</span><span class="ellipsis">•</span><span class="ellipsis">•</span></td>
        </tr>`;
      }
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
          <th class="right">response time</th>
          <th class="right">status</th>
          <th class="right">cf-ray</th>
        </tr>
        ${requests.map((request) => createRequestRow(request)).join('')}
      </table>
    `;
  })(requests.filter(({ request }) => Date.now() - request.timestamp.valueOf() <= interval * 1000));
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

const script = await compileScript();

Deno.serve({ port: 80, hostname: '0.0.0.0' }, (request) => {
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
  const html = `<!DOCTYPE html>
    <html>
    <head>
    <title>Monitoring</title>
    <meta name='viewport' content='width=device-width, initial-scale=1.0' />
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Nunito+Sans:ital,opsz,wght@0,6..12,200..1000;1,6..12,200..1000&family=Roboto+Mono:ital,wght@0,100..700;1,100..700&display=swap" rel="stylesheet">    <style>
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

      .ellipsis {
        color: #ccc;
        animation: animate 1.5s infinite;
      }
      .ellipsis:nth-child(1) {
        animation-delay: 0s;
      }
      .ellipsis:nth-child(2) {
        animation-delay: 0.5s;
      }
      .ellipsis:nth-child(3) {
        animation-delay: 1s;
      }

      @keyframes animate {
        0%, 66%, 100% {
          color: #ccc;
        }
        33% {
          color: black;
        }
      }
    </style>
    <script>${script}</script>
    </head>
      <body style="padding: 0 16px">
        <div id="root" style="max-width: 400px; margin: 0px auto">
          <div style="text-align: center">
            <span class="ellipsis">•</span><span class="ellipsis">•</span><span class="ellipsis">•</span>
          </div>
        </div>
      </body>
    </html>`;
  return new Response(html, { headers: { 'Content-type': 'text/html; charset=utf-8' } });
});
