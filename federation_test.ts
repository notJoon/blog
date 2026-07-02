import { assertEquals, assertExists } from "@std/assert";
import { createFederationInstance } from "./federation.ts";

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
