// Answers the app's /api requests inside the page. fetch and XMLHttpRequest are wrapped so that a
// same-origin request whose path starts with /api/ goes to the demo's routes instead of the
// network; everything else (the app's own files, other sites) passes through untouched.
//
// This sits under the real web/src/api/client.ts, so the demo runs the same client code as
// production, plus the three calls that don't use it (the submit page's form post, attachment
// uploads and backup restore). No service worker: nothing to register, and it also works where
// service workers don't (Firefox private windows, for one).

import { dispatch, type DemoBackend, type DemoRequest, type DemoResponse, type Method } from './server/routes';

/** A short, random wait, so loading states show up as they would over a network. */
export function fakeLatency(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));
}

/** The /api path of a same-origin URL, or null for anything the demo shouldn't answer. */
export function apiUrl(input: string | URL): URL | null {
  let url: URL;
  try {
    url = new URL(input, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  return url.pathname === '/api' || url.pathname.startsWith('/api/') ? url : null;
}

type Body = { json: unknown; form: FormData | null };

async function readBody(body: BodyInit | null | undefined): Promise<Body> {
  if (body === null || body === undefined) return { json: undefined, form: null };
  if (body instanceof FormData) return { json: undefined, form: body };
  const text = typeof body === 'string' ? body : await new Response(body).text();
  if (!text) return { json: undefined, form: null };
  try {
    return { json: JSON.parse(text), form: null };
  } catch {
    return { json: text, form: null };
  }
}

function toRequest(method: string, url: URL, headers: Headers, body: Body): Omit<DemoRequest, 'params'> {
  return {
    method: method.toUpperCase() as Method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    body: body.json,
    form: body.form,
    headers,
  };
}

const json = (res: DemoResponse) => (res.status === 204 || res.body === undefined ? null : JSON.stringify(res.body));

export function installTransport(backend: DemoBackend): void {
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const url = apiUrl(req ? req.url : (input as string | URL));
    if (!url) return realFetch(input, init);

    const signal = init?.signal ?? req?.signal;
    const method = init?.method ?? req?.method ?? 'GET';
    const headers = new Headers(req?.headers);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    const body = await readBody(init?.body ?? (req && method !== 'GET' ? await req.clone().blob() : undefined));

    await fakeLatency();
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    const res = dispatch(backend, toRequest(method, url, headers, body));
    return new Response(json(res), { status: res.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  };

  const RealXHR = window.XMLHttpRequest;

  /** An XMLHttpRequest that answers /api requests itself (open, headers, send, progress, abort). */
  class DemoXHR extends RealXHR {
    #demo: { method: string; url: URL; headers: Headers } | null = null;
    #status = 0;
    #text = '';
    #state = 0;
    #aborted = false;

    override open(method: string, url: string | URL, async = true, user?: string | null, password?: string | null): void {
      const api = apiUrl(url);
      if (!api) {
        this.#demo = null;
        super.open(method, url, async, user, password);
        return;
      }
      this.#demo = { method, url: api, headers: new Headers() };
      this.#status = 0;
      this.#text = '';
      this.#aborted = false;
      this.#setState(1);
    }

    override setRequestHeader(name: string, value: string): void {
      if (this.#demo) this.#demo.headers.set(name, value);
      else super.setRequestHeader(name, value);
    }

    override send(body?: Document | XMLHttpRequestBodyInit | null): void {
      const demo = this.#demo;
      if (!demo) {
        super.send(body);
        return;
      }
      void (async () => {
        const parsed = await readBody(body instanceof Document ? null : (body as BodyInit | null | undefined));
        await fakeLatency();
        if (this.#aborted) return;
        this.upload.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: 1, total: 1 }));
        const res = dispatch(backend, toRequest(demo.method, demo.url, demo.headers, parsed));
        this.#status = res.status;
        this.#text = json(res) ?? '';
        this.#setState(4);
        this.dispatchEvent(new ProgressEvent('load'));
        this.dispatchEvent(new ProgressEvent('loadend'));
      })();
    }

    override abort(): void {
      if (!this.#demo) {
        super.abort();
        return;
      }
      if (this.#aborted || this.#state === 4) return;
      this.#aborted = true;
      this.#setState(4);
      this.dispatchEvent(new ProgressEvent('abort'));
      this.dispatchEvent(new ProgressEvent('loadend'));
    }

    #setState(n: number): void {
      this.#state = n;
      this.dispatchEvent(new Event('readystatechange'));
    }

    override get readyState(): number {
      return this.#demo ? this.#state : super.readyState;
    }

    override get status(): number {
      return this.#demo ? this.#status : super.status;
    }

    override get responseText(): string {
      return this.#demo ? this.#text : super.responseText;
    }

    override get response(): unknown {
      if (!this.#demo) return super.response;
      if (this.responseType === 'json') {
        try {
          return JSON.parse(this.#text);
        } catch {
          return null;
        }
      }
      return this.#text;
    }

    override getResponseHeader(name: string): string | null {
      if (!this.#demo) return super.getResponseHeader(name);
      return name.toLowerCase() === 'content-type' && this.#state === 4 ? 'application/json; charset=utf-8' : null;
    }
  }

  window.XMLHttpRequest = DemoXHR;
}
