import { assertEquals, assertExists, assertInstanceOf } from "@std/assert";
import type { Context, InboxContext } from "@fedify/fedify";
import {
  Accept,
  Create,
  Follow,
  Note,
  Person,
  PUBLIC_COLLECTION,
  Undo,
} from "@fedify/vocab";
import {
  createFederationInstance,
  followerKey,
  FOLLOWERS_PAGE_SIZE,
  followersPrefix,
  handleFollow,
  handleUndo,
  postKey,
  publishPost,
  USER,
} from "./federation.ts";

async function makeFederation() {
  const kv = await Deno.openKv(":memory:");
  const federation = createFederationInstance(kv);
  return { kv, federation };
}

function apGet(path: string): Request {
  return new Request(`http://localhost:8000${path}`, {
    headers: { accept: "application/activity+json" },
  });
}

async function seedFollowers(kv: Deno.Kv, count: number) {
  for (let i = 0; i < count; i++) {
    const id = `https://remote.example/users/u${String(i).padStart(3, "0")}`;
    await kv.set(followerKey(id), { id, inboxId: `${id}/inbox` });
  }
}

async function getFollowersFirstPage(
  federation: ReturnType<typeof createFederationInstance>,
) {
  const collection =
    await (await federation.fetch(apGet("/users/me/followers"), {
      contextData: undefined,
    })).json();
  const first = new URL(collection.first);
  return await (await federation.fetch(apGet(first.pathname + first.search), {
    contextData: undefined,
  })).json();
}

Deno.test("actor dispatcher returns Person for /users/me", async () => {
  const { kv, federation } = await makeFederation();
  try {
    const res = await federation.fetch(apGet("/users/me"), {
      contextData: undefined,
    });
    assertEquals(res.status, 200);
    const actor = await res.json();
    assertEquals(actor.type, "Person");
    assertEquals(actor.preferredUsername, "me");
    assertExists(actor.inbox);
    assertExists(actor.outbox);
    assertExists(actor.followers);
    // RSA key for HTTP Signatures
    assertExists(actor.publicKey.publicKeyPem);
    // both keys exposed as Multikeys; z6Mk… multibase prefix = Ed25519
    assertEquals(actor.assertionMethod.length, 2);
    assertExists(actor.assertionMethod.find(
      (k: { publicKeyMultibase: string }) =>
        k.publicKeyMultibase.startsWith("z6Mk"),
    ));
  } finally {
    kv.close();
  }
});

Deno.test("actor dispatcher returns 404 for unknown user", async () => {
  const { kv, federation } = await makeFederation();
  try {
    const res = await federation.fetch(apGet("/users/nobody"), {
      contextData: undefined,
    });
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    kv.close();
  }
});

Deno.test("webfinger resolves acct:me@localhost:8000 to actor URL", async () => {
  const { kv, federation } = await makeFederation();
  try {
    const res = await federation.fetch(
      new Request(
        "http://localhost:8000/.well-known/webfinger?resource=acct:me@localhost:8000",
      ),
      { contextData: undefined },
    );
    assertEquals(res.status, 200);
    const jrd = await res.json();
    assertEquals(jrd.subject, "acct:me@localhost:8000");
    const self = jrd.links.find((l: { rel: string }) => l.rel === "self");
    assertEquals(self.href, "http://localhost:8000/users/me");
  } finally {
    kv.close();
  }
});

interface Sent {
  recipient: unknown;
  activity: unknown;
}

// ponytail: fake ctx with only the two methods the handlers touch
function fakeInboxCtx(sent: Sent[]): InboxContext<void> {
  return {
    parseUri: (uri: URL | null) =>
      uri?.href === "http://localhost:8000/users/me"
        ? { type: "actor", identifier: USER }
        : null,
    sendActivity: (_sender: unknown, recipient: unknown, activity: unknown) => {
      sent.push({ recipient, activity });
      return Promise.resolve();
    },
  } as unknown as InboxContext<void>;
}

function makeFollow(followerId = "https://remote.example/users/alice") {
  const follower = new Person({
    id: new URL(followerId),
    preferredUsername: "alice",
    inbox: new URL(`${followerId}/inbox`),
  });
  return new Follow({
    id: new URL("https://remote.example/follows/1"),
    actor: follower,
    object: new URL("http://localhost:8000/users/me"),
  });
}

Deno.test("Follow stores follower and replies with Accept", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const sent: Sent[] = [];
    await handleFollow(fakeInboxCtx(sent), makeFollow(), kv);

    const entry = await kv.get<{ id: string; inboxId: string }>(
      followerKey("https://remote.example/users/alice"),
    );
    assertExists(entry.value);
    assertEquals(
      entry.value.inboxId,
      "https://remote.example/users/alice/inbox",
    );

    assertEquals(sent.length, 1);
    const accept = sent[0].activity as Accept;
    assertInstanceOf(accept, Accept);
    assertEquals(accept.actorId?.href, "http://localhost:8000/users/me");
    assertEquals(accept.objectId?.href, "https://remote.example/follows/1");
    assertEquals(
      (sent[0].recipient as Person).id?.href,
      "https://remote.example/users/alice",
    );
  } finally {
    kv.close();
  }
});

Deno.test("Follow targeting another actor is ignored", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const sent: Sent[] = [];
    const follow = new Follow({
      id: new URL("https://remote.example/follows/2"),
      actor: new Person({
        id: new URL("https://remote.example/users/alice"),
        inbox: new URL("https://remote.example/users/alice/inbox"),
      }),
      object: new URL("http://localhost:8000/users/nobody"),
    });
    await handleFollow(fakeInboxCtx(sent), follow, kv);

    assertEquals(sent.length, 0);
    const entries = await Array.fromAsync(kv.list({ prefix: followersPrefix }));
    assertEquals(entries.length, 0);
  } finally {
    kv.close();
  }
});

Deno.test("Undo(Follow) removes follower", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const sent: Sent[] = [];
    const follow = makeFollow();
    await handleFollow(fakeInboxCtx(sent), follow, kv);

    const undo = new Undo({
      actor: new URL("https://remote.example/users/alice"),
      object: follow,
    });
    await handleUndo(fakeInboxCtx(sent), undo, kv);

    const entry = await kv.get(
      followerKey("https://remote.example/users/alice"),
    );
    assertEquals(entry.value, null);
  } finally {
    kv.close();
  }
});

Deno.test("Undo(Follow) targeting another actor keeps follower", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const sent: Sent[] = [];
    await handleFollow(fakeInboxCtx(sent), makeFollow(), kv);

    const undo = new Undo({
      actor: new URL("https://remote.example/users/alice"),
      object: new Follow({
        id: new URL("https://remote.example/follows/9"),
        actor: new URL("https://remote.example/users/alice"),
        object: new URL("https://other.example/users/someone"),
      }),
    });
    await handleUndo(fakeInboxCtx(sent), undo, kv);

    const entry = await kv.get(
      followerKey("https://remote.example/users/alice"),
    );
    assertExists(entry.value);
  } finally {
    kv.close();
  }
});

Deno.test("followers page of exactly PAGE_SIZE has no next", async () => {
  const { kv, federation } = await makeFederation();
  try {
    await seedFollowers(kv, FOLLOWERS_PAGE_SIZE);

    const page = await getFollowersFirstPage(federation);
    assertEquals(page.orderedItems.length, FOLLOWERS_PAGE_SIZE);
    assertEquals(page.next, undefined);
  } finally {
    kv.close();
  }
});

Deno.test("followers collection lists stored followers with pagination", async () => {
  const { kv, federation } = await makeFederation();
  try {
    await seedFollowers(kv, FOLLOWERS_PAGE_SIZE + 1);

    const page1 = await getFollowersFirstPage(federation);
    assertEquals(page1.orderedItems.length, FOLLOWERS_PAGE_SIZE);
    assertExists(page1.next);

    const nextUrl = new URL(page1.next);
    const page2 =
      await (await federation.fetch(apGet(nextUrl.pathname + nextUrl.search), {
        contextData: undefined,
      })).json();
    assertEquals([page2.orderedItems].flat().length, 1);
  } finally {
    kv.close();
  }
});

// ponytail: fake ctx with only the methods publishPost touches
function fakePublishCtx(sent: Sent[]): Context<void> {
  return {
    getObjectUri: (_cls: unknown, values: { identifier: string; id: string }) =>
      new URL(
        `http://localhost:8000/users/${values.identifier}/notes/${values.id}`,
      ),
    getActorUri: (identifier: string) =>
      new URL(`http://localhost:8000/users/${identifier}`),
    getFollowersUri: (identifier: string) =>
      new URL(`http://localhost:8000/users/${identifier}/followers`),
    sendActivity: (_sender: unknown, recipient: unknown, activity: unknown) => {
      sent.push({ recipient, activity });
      return Promise.resolve();
    },
  } as unknown as Context<void>;
}

Deno.test("publishPost stores post and fans out Create(Note) to followers", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const sent: Sent[] = [];
    const post = await publishPost(fakePublishCtx(sent), kv, "<p>hello</p>");

    const entry = await kv.get<{ content: string }>(postKey(post.id));
    assertExists(entry.value);
    assertEquals(entry.value.content, "<p>hello</p>");

    assertEquals(sent.length, 1);
    assertEquals(sent[0].recipient, "followers");
    const create = sent[0].activity as Create;
    assertInstanceOf(create, Create);
    assertEquals(create.actorId?.href, "http://localhost:8000/users/me");
    assertEquals(
      create.ccIds[0]?.href,
      "http://localhost:8000/users/me/followers",
    );

    const note = await create.getObject(fakePublishCtx(sent));
    assertInstanceOf(note, Note);
    assertEquals(
      note.id?.href,
      `http://localhost:8000/users/me/notes/${post.id}`,
    );
    assertEquals(note.content, "<p>hello</p>");
    assertEquals(note.attributionId?.href, "http://localhost:8000/users/me");
    assertEquals(note.toIds[0]?.href, PUBLIC_COLLECTION.href);
    assertEquals(
      note.ccIds[0]?.href,
      "http://localhost:8000/users/me/followers",
    );
    assertExists(note.published);
  } finally {
    kv.close();
  }
});

Deno.test("object dispatcher serves stored Note at its URL", async () => {
  const { kv, federation } = await makeFederation();
  try {
    await kv.set(postKey("abc"), {
      id: "abc",
      content: "<p>hi</p>",
      published: "2026-07-03T00:00:00Z",
    });

    const res = await federation.fetch(apGet("/users/me/notes/abc"), {
      contextData: undefined,
    });
    assertEquals(res.status, 200);
    const note = await res.json();
    assertEquals(note.type, "Note");
    assertEquals(note.content, "<p>hi</p>");
    assertEquals(note.attributedTo, "http://localhost:8000/users/me");
    assertExists(note.published);
    // JSON-LD compaction may shorten the Public collection IRI to "as:Public"
    assertEquals(
      [note.to].flat().some((t: string) =>
        t === PUBLIC_COLLECTION.href || t === "as:Public"
      ),
      true,
    );
    assertEquals(note.cc, "http://localhost:8000/users/me/followers");
  } finally {
    kv.close();
  }
});

Deno.test("object dispatcher returns 404 for missing note", async () => {
  const { kv, federation } = await makeFederation();
  try {
    const res = await federation.fetch(apGet("/users/me/notes/nope"), {
      contextData: undefined,
    });
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    kv.close();
  }
});

Deno.test("key pairs persist across federation instances", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const fed1 = createFederationInstance(kv);
    const res1 = await fed1.fetch(apGet("/users/me"), {
      contextData: undefined,
    });
    const key1 = (await res1.json()).publicKey;

    const fed2 = createFederationInstance(kv);
    const res2 = await fed2.fetch(apGet("/users/me"), {
      contextData: undefined,
    });
    const key2 = (await res2.json()).publicKey;

    assertEquals(key1.publicKeyPem, key2.publicKeyPem);
  } finally {
    kv.close();
  }
});
