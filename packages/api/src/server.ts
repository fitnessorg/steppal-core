import { buildApp } from "./app.js";
import { loadEnv } from "./lib/env.js";

const env = loadEnv();
const app = buildApp();

app
  .listen({ port: env.PORT, host: env.HOST })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
