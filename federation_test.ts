import { assertEquals, assertExists, assertInstanceOf } from "@std/assert";
import type { InboxContext } from "@fedify/fedify";
import { Accept, Follow, Person, Undo } from "@fedify/vocab";
import {
  createFederationInstance,
  FOLLOWERS_PAGE_SIZE,
  handleFollow,
  handleUndo,
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
      ["followers", USER, "https://remote.example/users/alice"],
    );
    assertExists(entry.value);
    assertEquals(entry.value.inboxId, "https://remote.example/users/alice/inbox");

    assertEquals(sent.length, 1);
    const accept = sent[0].activity as Accept;
    assertInstanceOf(accept, Accept);
    assertEquals(accept.actorId?.href, "http://localhost:8000/users/me");
    assertEquals(accept.objectId?.href, "https://remote.example/follows/1");
    assertEquals((sent[0].recipient as Person).id?.href, "https://remote.example/users/alice");
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
    const entries = await Array.fromAsync(kv.list({ prefix: ["followers"] }));
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

    const entry = await kv.get(["followers", USER, "https://remote.example/users/alice"]);
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

    const entry = await kv.get(["followers", USER, "https://remote.example/users/alice"]);
    assertExists(entry.value);
  } finally {
    kv.close();
  }
});

Deno.test("followers page of exactly PAGE_SIZE has no next", async () => {
  const { kv, federation } = await makeFederation();
  try {
    for (let i = 0; i < FOLLOWERS_PAGE_SIZE; i++) {
      const id = `https://remote.example/users/u${String(i).padStart(3, "0")}`;
      await kv.set(["followers", USER, id], { id, inboxId: `${id}/inbox` });
    }

    const collection = await (await federation.fetch(apGet("/users/me/followers"), {
      contextData: undefined,
    })).json();
    const first = new URL(collection.first);
    const page = await (await federation.fetch(apGet(first.pathname + first.search), {
      contextData: undefined,
    })).json();
    assertEquals(page.orderedItems.length, FOLLOWERS_PAGE_SIZE);
    assertEquals(page.next, undefined);
  } finally {
    kv.close();
  }
});

Deno.test("followers collection lists stored followers with pagination", async () => {
  const { kv, federation } = await makeFederation();
  try {
    const total = FOLLOWERS_PAGE_SIZE + 1;
    for (let i = 0; i < total; i++) {
      const id = `https://remote.example/users/u${String(i).padStart(3, "0")}`;
      await kv.set(["followers", USER, id], { id, inboxId: `${id}/inbox` });
    }

    const res = await federation.fetch(apGet("/users/me/followers"), {
      contextData: undefined,
    });
    assertEquals(res.status, 200);
    const collection = await res.json();
    assertExists(collection.first);

    const page1 = await (await federation.fetch(apGet(new URL(collection.first).pathname + new URL(collection.first).search), {
      contextData: undefined,
    })).json();
    assertEquals(page1.orderedItems.length, FOLLOWERS_PAGE_SIZE);
    assertExists(page1.next);

    const nextUrl = new URL(page1.next);
    const page2 = await (await federation.fetch(apGet(nextUrl.pathname + nextUrl.search), {
      contextData: undefined,
    })).json();
    assertEquals([page2.orderedItems].flat().length, 1);
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
