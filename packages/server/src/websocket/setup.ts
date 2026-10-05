/**
 * WebSocket route registration. Authenticates via the same API key used for
 * REST (passed as `?token=`) and registers the client with the broadcaster.
 */

import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { registerClient } from "./broadcast.js";

export function registerWebSocket(fastify: FastifyInstance, apiKey: string | undefined): void {
  fastify.register(async function (app) {
    app.get("/ws", { websocket: true }, (socket, request) => {
      if (apiKey) {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
        const token = url.searchParams.get("token") ?? "";
        const tokenBuf = Buffer.from(token);
        const keyBuf = Buffer.from(apiKey);
        if (tokenBuf.length !== keyBuf.length || !timingSafeEqual(tokenBuf, keyBuf)) {
          socket.close(1008, "Unauthorized");
          return;
        }
      }
      registerClient(socket);
      fastify.log.info("Dashboard client connected");
    });
  });
}
