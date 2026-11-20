import type { HttpRequest, HttpResponse, HttpTransport } from "../core/api/http";

export class FakeTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];

  constructor(
    private readonly handler: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>
  ) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return this.handler(request);
  }
}

export function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

export function emptyResponse(status: number): HttpResponse {
  return { status, headers: {}, body: "" };
}

export function requestPath(request: HttpRequest): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

export function requestPathname(request: HttpRequest): string {
  return new URL(request.url).pathname;
}

export function parseRequestBody(request: HttpRequest): unknown {
  if (!request.body) {
    return undefined;
  }
  try {
    return JSON.parse(request.body);
  } catch {
    return undefined;
  }
}
