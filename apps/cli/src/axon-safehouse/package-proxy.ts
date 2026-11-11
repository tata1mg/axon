import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, request as requestHttp } from "node:http";
import { connect, type Socket } from "node:net";

import { blockedHostsSchema, isBlockedNetworkHost } from "./network.ts";

export interface NetworkProxy {
  readonly origin: string;
  readonly authenticatedUrl: string;
  dispose(): void;
}

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded = { ...headers };
  const connectionHeaders = (headers.connection ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase());
  for (const name of [
    ...connectionHeaders,
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ])
    delete forwarded[name];
  return forwarded;
}

/**
 * Optional user blocklist for proxy-aware HTTP/HTTPS clients, not an OS network boundary.
 * All other hosts, ports and private/local addresses are allowed. Direct sockets,
 * SSH, UDP and clients that ignore proxy settings can bypass this filter.
 */
export async function startNetworkProxy(hosts: readonly string[]): Promise<NetworkProxy> {
  const blockedHosts = blockedHostsSchema.parse([...hosts]);
  const capability = crypto.randomUUID();
  const expected = Buffer.from(`Basic ${Buffer.from(`axon:${capability}`).toString("base64")}`);
  const sockets = new Set<Socket>();
  let stopped = false;
  const trackSocket = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const authorized = (headers: IncomingHttpHeaders): boolean => {
    const supplied = Buffer.from(headers["proxy-authorization"] ?? "");
    return !stopped && supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const server = createServer({ requestTimeout: 0 }, (request, response) => {
    if (!authorized(request.headers)) {
      response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="Axon host blocklist"' });
      response.end();
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? "");
      if (target.protocol !== "http:" || target.username || target.password)
        throw new Error("Invalid target");
      if (isBlockedNetworkHost(target.hostname, blockedHosts)) {
        response.writeHead(403);
        response.end("Host blocked by your Axon Safehouse settings");
        return;
      }
    } catch {
      response.writeHead(400);
      response.end("Expected an absolute HTTP URL");
      return;
    }
    const upstream = requestHttp(target, {
      method: request.method,
      headers: { ...forwardHeaders(request.headers), host: target.host },
      agent: false,
    });
    upstream.on("socket", trackSocket);
    upstream.once("response", (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, forwardHeaders(incoming.headers));
      incoming.on("error", () => response.destroy());
      incoming.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.once("aborted", () => upstream.destroy());
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connection", trackSocket);
  server.on("connect", (request, client, head) => {
    if (!authorized(request.headers)) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Axon host blocklist"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    let hostname: string;
    let port: number;
    try {
      const authority = request.url ?? "";
      if (!/^(?:\[[0-9a-fA-F:.]+\]|[^:/?#@\s]+):[0-9]+$/.test(authority))
        throw new Error("Invalid target");
      const target = new URL(`http://${authority}`);
      hostname = target.hostname.replace(/^\[|\]$/g, "");
      port = Number(authority.slice(authority.lastIndexOf(":") + 1));
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
      if (isBlockedNetworkHost(hostname, blockedHosts)) {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    client.pause();
    const upstream = connect({ host: hostname, port, allowHalfOpen: true });
    trackSocket(upstream);
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    upstream.once("connect", () => {
      if (stopped || client.destroyed) {
        upstream.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  const dispose = (): void => {
    if (stopped) return;
    stopped = true;
    server.close();
    for (const socket of sockets) socket.destroy();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Host blocklist proxy could not bind");
    return {
      origin: `http://127.0.0.1:${address.port}`,
      authenticatedUrl: `http://axon:${capability}@127.0.0.1:${address.port}`,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
