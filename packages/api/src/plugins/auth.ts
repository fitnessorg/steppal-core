import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { verifyAccessToken } from "../lib/tokens.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    userId?: string;
  }
}

/**
 * Decorates the app with `authenticate`, used as an onRequest hook on protected
 * routes. It never throws past the reply — an invalid token is a 401, not a 500,
 * because an expired token is the normal state of a phone that has been in a
 * pocket for an hour.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "missing_token" });
    }

    try {
      const claims = await verifyAccessToken(header.slice(7));
      request.userId = claims.sub;
    } catch {
      return reply.code(401).send({ error: "invalid_token" });
    }
  });
});
