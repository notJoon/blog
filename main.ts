import { Hono } from "@hono/hono";
import { html, raw } from "@hono/hono/html";
import { bearerAuth } from "@hono/hono/bearer-auth";
import { federation } from "@fedify/hono";
import { behindProxy } from "@hongminhee/x-forwarded-fetch";
import { configure, getConsoleSink } from "@logtape/logtape";
import {
  createFederationInstance,
  postKey,
  postsPrefix,
  publishPost,
  USER,
} from "./federation.ts";
import type { StoredPost } from "./federation.ts";

type Html = ReturnType<typeof html>;

function configureLogging() {
  return configure({
    sinks: { console: getConsoleSink() },
    loggers: [
      { category: "fedify", lowestLevel: "info", sinks: ["console"] },
      {
        category: ["logtape", "meta"],
        lowestLevel: "warning",
        sinks: ["console"],
      },
    ],
  });
}

async function listPosts(kv: Deno.Kv): Promise<StoredPost[]> {
  const entries = await Array.fromAsync(
    kv.list<StoredPost>({ prefix: postsPrefix }),
  );
  // ponytail: in-memory sort; paginate when post count actually hurts
  return entries
    .map((e) => e.value)
    .sort((a, b) => b.published.localeCompare(a.published));
}

function page(title: string, body: Html): Html {
  return html`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${title}</title>
      </head>
      <body>
        ${body}
      </body>
    </html>
  `;
}

// post content is owner-authored HTML → rendered raw on purpose
function article(post: StoredPost): Html {
  return html`<article>
    <a href="/users/${USER}/notes/${post.id}"><time>${post.published}</time></a>
    ${raw(post.content)}
  </article>`;
}

export function createApp(kv: Deno.Kv, publishToken?: string) {
  const fed = createFederationInstance(kv);
  const app = new Hono();

  // content negotiation: activity+json → Fedify, otherwise falls through to routes below
  app.use(federation(fed, () => undefined));

  app.get("/", async (c) => {
    const posts = await listPosts(kv);
    return c.html(
      page(
        "Deeeeeemo",
        html`<h1>Deeeeeemo</h1>
          <p>
            <a href="/users/${USER}">@${USER}@${new URL(c.req.url).host}</a>
          </p>
          ${posts.map(article)}`,
      ),
    );
  });

  app.get("/users/:identifier", (c) => {
    if (c.req.param("identifier") !== USER) return c.notFound();
    return c.html(
      page(
        "Deeeeeemo",
        html`<h1>Deeeeeemo</h1>
          <p>@${USER}@${new URL(c.req.url).host}</p>
          <p><a href="/">글 목록</a></p>`,
      ),
    );
  });

  app.get("/users/:identifier/notes/:id", async (c) => {
    if (c.req.param("identifier") !== USER) return c.notFound();
    const post = (await kv.get<StoredPost>(postKey(c.req.param("id")))).value;
    if (post == null) return c.notFound();
    return c.html(page("Deeeeeemo", article(post)));
  });

  // ponytail: endpoint only exists when a token is configured — no token, no publish
  if (publishToken) {
    app.post("/publish", bearerAuth({ token: publishToken }), async (c) => {
      const body = await c.req.parseBody();
      const content = body.content;
      if (typeof content !== "string" || content.trim() === "") {
        return c.text("content required", 400);
      }
      const ctx = fed.createContext(new URL(c.req.url), undefined);
      const post = await publishPost(ctx, kv, content);
      return c.redirect(`/users/${USER}/notes/${post.id}`);
    });
  }

  return app;
}

if (import.meta.main) {
  await configureLogging();
  const kv = await Deno.openKv();
  const app = createApp(kv, Deno.env.get("PUBLISH_TOKEN"));
  // tunnels/reverse proxies terminate TLS; restore scheme+host from X-Forwarded-* headers
  Deno.serve(behindProxy(app.fetch));
}
