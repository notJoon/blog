import { assertEquals, assertExists } from "@std/assert";
import { createApp } from "./main.ts";
import { postKey } from "./federation.ts";

const TOKEN = "test-token";

async function makeApp() {
  const kv = await Deno.openKv(":memory:");
  const app = createApp(kv, TOKEN);
  return { kv, app };
}

async function seedPost(
  kv: Deno.Kv,
  id: string,
  content: string,
  published: string,
) {
  await kv.set(postKey(id), { id, content, published });
}

Deno.test("GET / lists posts newest first", async () => {
  const { kv, app } = await makeApp();
  try {
    await seedPost(kv, "a", "<p>older post</p>", "2026-07-01T00:00:00Z");
    await seedPost(kv, "b", "<p>newer post</p>", "2026-07-02T00:00:00Z");

    const res = await app.request("/");
    assertEquals(res.status, 200);
    const body = await res.text();
    assertEquals(body.includes("newer post"), true);
    assertEquals(body.includes("older post"), true);
    assertEquals(body.indexOf("newer post") < body.indexOf("older post"), true);
  } finally {
    kv.close();
  }
});

Deno.test("GET /users/me serves HTML profile to browsers", async () => {
  const { kv, app } = await makeApp();
  try {
    const res = await app.request("/users/me", {
      headers: { accept: "text/html" },
    });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type")?.includes("text/html"), true);
    const body = await res.text();
    assertEquals(body.includes("Deeeeeemo"), true);
  } finally {
    kv.close();
  }
});

Deno.test(
  "GET /users/me still serves ActivityPub JSON via content negotiation",
  async () => {
    const { kv, app } = await makeApp();
    try {
      const res = await app.request("/users/me", {
        headers: { accept: "application/activity+json" },
      });
      assertEquals(res.status, 200);
      const actor = await res.json();
      assertEquals(actor.type, "Person");
      assertEquals(actor.preferredUsername, "me");
    } finally {
      kv.close();
    }
  },
);

Deno.test("GET /users/me/notes/:id renders post HTML", async () => {
  const { kv, app } = await makeApp();
  try {
    await seedPost(kv, "abc", "<p>hello html</p>", "2026-07-03T00:00:00Z");

    const res = await app.request("/users/me/notes/abc", {
      headers: { accept: "text/html" },
    });
    assertEquals(res.status, 200);
    assertEquals((await res.text()).includes("hello html"), true);

    const missing = await app.request("/users/me/notes/nope", {
      headers: { accept: "text/html" },
    });
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
  } finally {
    kv.close();
  }
});

Deno.test("POST /publish rejects missing or wrong token", async () => {
  const { kv, app } = await makeApp();
  try {
    const noAuth = await app.request("/publish", {
      method: "POST",
      body: new URLSearchParams({ content: "<p>x</p>" }),
    });
    assertEquals(noAuth.status, 401);
    await noAuth.body?.cancel();

    const wrong = await app.request("/publish", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: new URLSearchParams({ content: "<p>x</p>" }),
    });
    assertEquals(wrong.status, 401);
    await wrong.body?.cancel();
  } finally {
    kv.close();
  }
});

Deno.test(
  "POST /publish with token stores post and redirects to it",
  async () => {
    const { kv, app } = await makeApp();
    try {
      const res = await app.request("/publish", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: new URLSearchParams({ content: "<p>posted</p>" }),
      });
      assertEquals(res.status, 302);
      const location = res.headers.get("location");
      assertExists(location);
      const id = location.split("/").pop()!;
      const entry = await kv.get<{ content: string }>(postKey(id));
      assertEquals(entry.value?.content, "<p>posted</p>");
    } finally {
      kv.close();
    }
  },
);

Deno.test("publish endpoint is absent without a token", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const app = createApp(kv);
    const res = await app.request("/publish", {
      method: "POST",
      body: new URLSearchParams({ content: "<p>x</p>" }),
    });
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    kv.close();
  }
});
