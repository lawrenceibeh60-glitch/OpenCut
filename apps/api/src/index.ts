import { Elysia, t } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";

export default new Elysia({ adapter: CloudflareAdapter })
  .get("/", () => ({ product: "KYROCUT X1", service: "api", status: "ok" }))
  .get("/health", () => ({ product: "KYROCUT X1", healthy: true, timestamp: new Date().toISOString() }))
  .post(
    "/echo",
    ({ body }) => body,
    {
      body: t.Object({ message: t.String() }),
    }
  )
  // .compile() is required, it triggers AoT compilation at startup
  .compile();
