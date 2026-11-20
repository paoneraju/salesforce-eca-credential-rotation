export interface HttpRequest {
  url: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export class TransportError extends Error {
  readonly code: "TIMEOUT" | "NETWORK" | "PROTOCOL" | "TOO_LARGE";

  constructor(code: "TIMEOUT" | "NETWORK" | "PROTOCOL" | "TOO_LARGE", message: string) {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}

export function assertSalesforceInstanceUrl(instanceUrl: string): string {
  let url: URL;
  try {
    url = new URL(instanceUrl);
  } catch {
    throw new Error("The Salesforce instance URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Salesforce API requests require an HTTPS instance URL.");
  }
  if (url.username || url.password) {
    throw new Error("The Salesforce instance URL must not contain embedded credentials.");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    host.endsWith(".salesforce.com") ||
    host.endsWith(".force.com") ||
    host.endsWith(".cloudforce.com");
  if (!allowed) {
    throw new Error(`Refusing to send Salesforce credentials to unexpected host: ${host}`);
  }
  return url.origin;
}
