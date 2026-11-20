import * as https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { HttpRequest, HttpResponse, HttpTransport, TransportError } from "./http";

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string | string[] | undefined> {
  const output: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    output[key.toLowerCase()] = value;
  }
  return output;
}

export class NodeHttpsTransport implements HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse> {
    const url = new URL(request.url);
    if (url.protocol !== "https:") {
      return Promise.reject(new TransportError("PROTOCOL", "Only HTTPS requests are allowed."));
    }

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        callback();
      };

      const req = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers: {
            Accept: "application/json",
            "User-Agent": "salesforce-eca-credential-rotation-vscode",
            ...request.headers
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const limit = request.maxResponseBytes ?? DEFAULT_MAX_BYTES;

          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
              req.destroy(new TransportError("TOO_LARGE", "The Salesforce response exceeded the size limit."));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            finish(() =>
              resolve({
                status: res.statusCode ?? 0,
                headers: normalizeHeaders(res.headers),
                body: Buffer.concat(chunks).toString("utf8")
              })
            );
          });
          res.on("error", (error) => {
            finish(() =>
              reject(
                error instanceof TransportError
                  ? error
                  : new TransportError("NETWORK", "The Salesforce response could not be read.")
              )
            );
          });
        }
      );

      req.setTimeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
        req.destroy(new TransportError("TIMEOUT", "The Salesforce request timed out."));
      });

      req.on("error", (error) => {
        finish(() => {
          if (error instanceof TransportError) {
            reject(error);
          } else {
            reject(new TransportError("NETWORK", "The Salesforce request failed due to a network error."));
          }
        });
      });

      if (request.body !== undefined) {
        req.write(request.body);
      }
      req.end();
    });
  }
}
