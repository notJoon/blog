import { configure, getConsoleSink } from "@logtape/logtape";
import { createFederationInstance } from "./federation.ts";

await configure({
  sinks: { console: getConsoleSink() },
  loggers: [
    { category: "fedify", lowestLevel: "info", sinks: ["console"] },
    { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
  ],
});

export function handler(req: Request): Response {
  const url = new URL(req.url);

  if (url.pathname === "/api") {
    return Response.json({
      message: "Hello, world!",
      time: new Date().toISOString(),
    });
  }

  return new Response("<h1>Welcome to Deno!</h1>", {
    headers: { "content-type": "text/html" },
  });
}

if (import.meta.main) {
  const kv = await Deno.openKv();
  const federation = createFederationInstance(kv);
  Deno.serve((req) =>
    federation.fetch(req, {
      contextData: undefined,
      onNotFound: () => Promise.resolve(handler(req)),
    })
  );
}
