import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { BlockList, connect, createServer as createTcpServer, type Socket } from "node:net";

import type { SandboxPolicy } from "./policy.ts";

const blockedAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedAddresses.addSubnet(address, prefix, "ipv4");

/** Resolve once and reject private/reserved destinations before a parent-owned connection. */
export async function lookupPublicAddress(hostname: string): Promise<string> {
  const addresses = await lookup(hostname, { family: 4, all: true });
  const address = addresses[0];
  if (
    address === undefined ||
    addresses.some((entry) => blockedAddresses.check(entry.address, "ipv4"))
  )
    throw new Error("Sandbox proxy destination must resolve only to public addresses");
  return address.address;
}

export interface PackageProxy {
  readonly origin: string;
  readonly authenticatedUrl: string;
  readonly sshTunnels: readonly { readonly host: string; readonly port: number }[];
  dispose(): void;
}

/** HTTPS CONNECT only, exact reviewed registries, public DNS results pinned per connection. */
export async function startPackageProxy(policy: SandboxPolicy): Promise<PackageProxy> {
  const capability = crypto.randomUUID();
  const expected = Buffer.from(`Basic ${Buffer.from(`axon:${capability}`).toString("base64")}`);
  const allowedHosts = new Set<string>(policy.packageRegistryHosts);
  const sockets = new Set<Socket>();
  const sshServers: ReturnType<typeof createTcpServer>[] = [];
  const sshTunnels: { readonly host: string; readonly port: number }[] = [];
  let stopped = false;
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10_000 },
    (_request, response) => {
      response.writeHead(403, { Connection: "close" });
      response.end("Only approved HTTPS package registries are available");
    },
  );
  server.maxConnections = 64;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(90_000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  server.on("connect", (request, client, head) => {
    const supplied = Buffer.from(request.headers["proxy-authorization"] ?? "");
    const target = /^([a-z0-9.-]+):443$/.exec(request.url ?? "");
    if (
      stopped ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      !target?.[1] ||
      !allowedHosts.has(target[1]) ||
      head.length > 65536
    ) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const hostname = target[1];
    client.pause();
    void lookupPublicAddress(hostname)
      .then((address) => {
        // Pin a checked numerical address; never resolve the name again in connect().
        if (stopped || client.destroyed) {
          client.destroy();
          return;
        }
        const upstream = connect({ host: address, port: 443 });
        sockets.add(upstream);
        upstream.setTimeout(90_000, () => upstream.destroy());
        upstream.once("close", () => {
          sockets.delete(upstream);
          client.destroy();
        });
        upstream.on("error", () => {
          upstream.destroy();
          client.destroy();
        });
        client.once("close", () => upstream.destroy());
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
      })
      .catch(() => client.destroy());
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  const dispose = (): void => {
    stopped = true;
    server.close();
    for (const sshServer of sshServers) sshServer.close();
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
    // Seatbelt cannot restrict TCP by remote hostname/IP. One loopback listener per
    // approved host preserves the allowlist without granting general port-22 access.
    // These are raw TCP tunnels only: SSH credentials and Git both stay in the sandbox.
    for (const host of policy.remoteGit ? new Set(policy.remoteGitHosts) : []) {
      const address = await lookupPublicAddress(host);
      const sshServer = createTcpServer({ allowHalfOpen: true }, (client) => {
        if (stopped) {
          client.destroy();
          return;
        }
        const upstream = connect({ host: address, port: 22, allowHalfOpen: true });
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.setTimeout(90_000, () => socket.destroy());
          socket.on("error", () => socket.destroy());
          socket.once("close", () => sockets.delete(socket));
        }
        client.pause();
        client.once("close", () => upstream.destroy());
        upstream.once("close", () => client.destroy());
        upstream.once("connect", () => {
          if (stopped || client.destroyed) {
            upstream.destroy();
            return;
          }
          client.pipe(upstream);
          upstream.pipe(client);
          client.resume();
        });
      });
      sshServer.maxConnections = 16;
      sshServers.push(sshServer);
      await new Promise<void>((resolve, reject) => {
        sshServer.once("error", reject);
        sshServer.listen(0, "127.0.0.1", () => {
          sshServer.off("error", reject);
          resolve();
        });
      });
      const endpoint = sshServer.address();
      if (!endpoint || typeof endpoint === "string") throw new Error("SSH tunnel could not bind");
      sshTunnels.push({ host, port: endpoint.port });
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Package proxy could not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    return {
      origin,
      authenticatedUrl: `http://axon:${capability}@127.0.0.1:${address.port}`,
      sshTunnels,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
