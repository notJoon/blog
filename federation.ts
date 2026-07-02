import {
  createFederation,
  exportJwk,
  generateCryptoKeyPair,
  importJwk,
  InProcessMessageQueue,
  MemoryKvStore,
} from "@fedify/fedify";
import { Endpoints, Person } from "@fedify/vocab";

// TODO: single-user blog, hardcoded identifier
export const USER = "me";

interface StoredKeyPair {
  privateKey: JsonWebKey;
  publicKey: JsonWebKey;
}

const KEY_TYPES = ["RSASSA-PKCS1-v1_5", "Ed25519"] as const;

export function createFederationInstance(kv: Deno.Kv) {
  const federation = createFederation<void>({
    // TODO: dev stores. swap to @fedify/denokv DenoKvStore/DenoKvMessageQueue at deploy (Phase 6)
    kv: new MemoryKvStore(),
    queue: new InProcessMessageQueue(),
  });

  federation
    .setActorDispatcher("/users/{identifier}", async (ctx, identifier) => {
      if (identifier !== USER) return null;
      const keys = await ctx.getActorKeyPairs(identifier);
      return new Person({
        id: ctx.getActorUri(identifier),
        preferredUsername: identifier,
        name: "Lee ByeongJun",
        inbox: ctx.getInboxUri(identifier),
        outbox: ctx.getOutboxUri(identifier),
        followers: ctx.getFollowersUri(identifier),
        endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
        publicKey: keys[0]?.cryptographicKey,
        assertionMethods: keys.map((k) => k.multikey),
      });
    })
    .setKeyPairsDispatcher(async (_ctx, identifier) => {
      if (identifier !== USER) return [];
      const entry = await kv.get<StoredKeyPair[]>(["keys", identifier]);
      let stored = entry.value;
      if (stored == null) {
        const generated: StoredKeyPair[] = [];
        for (const type of KEY_TYPES) {
          const { privateKey, publicKey } = await generateCryptoKeyPair(type);
          generated.push({
            privateKey: await exportJwk(privateKey),
            publicKey: await exportJwk(publicKey),
          });
        }
        // atomic w/ versionstamp check: concurrent first fetches must agree on one key set
        const res = await kv.atomic()
          .check(entry)
          .set(["keys", identifier], generated)
          .commit();
        stored = res.ok
          ? generated
          : (await kv.get<StoredKeyPair[]>(["keys", identifier])).value!;
      }
      return Promise.all(stored.map(async (pair) => ({
        privateKey: await importJwk(pair.privateKey, "private"),
        publicKey: await importJwk(pair.publicKey, "public"),
      })));
    });

  // TODO: path registration only for now
  federation.setInboxListeners("/users/{identifier}/inbox", "/inbox");

  // TODO: empty stubs so actor's outbox/followers URIs resolve
  federation.setOutboxDispatcher(
    "/users/{identifier}/outbox",
    (_ctx, identifier) => {
      if (identifier !== USER) return null;
      return { items: [] };
    },
  );

  federation.setFollowersDispatcher(
    "/users/{identifier}/followers",
    (_ctx, identifier) => {
      if (identifier !== USER) return null;
      return { items: [] };
    },
  );

  return federation;
}
