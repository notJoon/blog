import {
  createFederation,
  exportJwk,
  generateCryptoKeyPair,
  importJwk,
  InProcessMessageQueue,
  MemoryKvStore,
} from "@fedify/fedify";
import type { InboxContext } from "@fedify/fedify";
import { Accept, Endpoints, Follow, Person, Undo } from "@fedify/vocab";
import type { Recipient } from "@fedify/vocab";

// TODO: single-user blog, hardcoded identifier
export const USER = "me";

export const FOLLOWERS_PAGE_SIZE = 50;

interface StoredKeyPair {
  privateKey: JsonWebKey;
  publicKey: JsonWebKey;
}

interface StoredFollower {
  id: string;
  inboxId: string;
}

const KEY_TYPES = ["RSASSA-PKCS1-v1_5", "Ed25519"] as const;

export async function handleFollow(
  ctx: InboxContext<void>,
  follow: Follow,
  kv: Deno.Kv,
) {
  if (follow.id == null || follow.objectId == null) return;
  const parsed = ctx.parseUri(follow.objectId);
  if (parsed?.type !== "actor" || parsed.identifier !== USER) return;
  const follower = await follow.getActor(ctx);
  if (follower?.id == null || follower.inboxId == null) return;
  // ponytail: id + inbox only; store endpoints.sharedInbox when fan-out volume matters
  await kv.set(["followers", USER, follower.id.href], {
    id: follower.id.href,
    inboxId: follower.inboxId.href,
  } satisfies StoredFollower);
  await ctx.sendActivity(
    { identifier: USER },
    follower,
    new Accept({ actor: follow.objectId, object: follow }),
  );
}

export async function handleUndo(
  ctx: InboxContext<void>,
  undo: Undo,
  kv: Deno.Kv,
) {
  const object = await undo.getObject(ctx);
  if (!(object instanceof Follow)) return;
  if (undo.actorId == null) return;
  const parsed = ctx.parseUri(object.objectId);
  if (parsed?.type !== "actor" || parsed.identifier !== USER) return;
  // signature verification upstream guarantees undo.actorId is the sender;
  // the inner Follow's actor must be that same sender
  if (object.actorId?.href !== undo.actorId.href) return;
  await kv.delete(["followers", USER, undo.actorId.href]);
}

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

  federation
    .setInboxListeners("/users/{identifier}/inbox", "/inbox")
    .on(Follow, (ctx, follow) => handleFollow(ctx, follow, kv))
    .on(Undo, (ctx, undo) => handleUndo(ctx, undo, kv));

  // TODO: empty stubs so actor's outbox/followers URIs resolve
  federation.setOutboxDispatcher(
    "/users/{identifier}/outbox",
    (_ctx, identifier) => {
      if (identifier !== USER) return null;
      return { items: [] };
    },
  );

  federation
    .setFollowersDispatcher(
      "/users/{identifier}/followers",
      async (_ctx, identifier, cursor) => {
        if (identifier !== USER) return null;
        // limit+1 probe: only emit nextCursor when a following item really exists
        const iter = kv.list<StoredFollower>({ prefix: ["followers", USER] }, {
          limit: FOLLOWERS_PAGE_SIZE + 1,
          cursor: cursor || undefined,
        });
        const items: Recipient[] = [];
        let nextCursor: string | null = null;
        let pageCursor = "";
        for await (const entry of iter) {
          if (items.length === FOLLOWERS_PAGE_SIZE) {
            nextCursor = pageCursor;
            break;
          }
          items.push({
            id: new URL(entry.value.id),
            inboxId: new URL(entry.value.inboxId),
          });
          pageCursor = iter.cursor;
        }
        return { items, nextCursor };
      },
    )
    .setFirstCursor((_ctx, identifier) => identifier === USER ? "" : null);

  return federation;
}
