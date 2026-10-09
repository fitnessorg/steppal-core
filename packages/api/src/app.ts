import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { loadEnv } from "./lib/env.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerPotRoutes } from "./routes/pots.js";
import { registerStepRoutes } from "./routes/steps.js";
import { authPlugin } from "./plugins/auth.js";

export function buildApp() {
  const env = loadEnv();

  const app = Fastify({
    logger:
      env.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty" } }
        : true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(cors);
  app.register(authPlugin);

  registerHealthRoutes(app);

  // Routes are registered after the auth plugin so `app.authenticate` exists
  // by the time a route references it in its onRequest hook.
  app.after(() => {
    registerAuthRoutes(app);
    registerPotRoutes(app);
    registerStepRoutes(app);
  });

  return app;
}
