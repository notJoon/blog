import {
  createFederation,
  exportJwk,
  generateCryptoKeyPair,
  importJwk,
} from "@fedify/fedify";
import { DenoKvMessageQueue, DenoKvStore } from "@fedify/denokv";
import type { Context, InboxContext } from "@fedify/fedify";
import {
  Accept,
  Create,
  Endpoints,
  Follow,
  Note,
  Person,
  PUBLIC_COLLECTION,
  Undo,
} from "@fedify/vocab";
import type { Recipient } from "@fedify/vocab";

// single-user blog: the one and only actor
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

export interface StoredPost {
  id: string;
  content: string;
  published: string; // ISO instant
}

export const postsPrefix = ["posts", USER] as const;
export const postKey = (id: string) => [...postsPrefix, id] as const;
export const followersPrefix = ["followers", USER] as const;
export const followerKey = (id: string) => [...followersPrefix, id] as const;

const KEY_TYPES = ["RSASSA-PKCS1-v1_5", "Ed25519"] as const;
type KeyType = typeof KEY_TYPES[number];

function isUserActor(ctx: InboxContext<void>, uri: URL | null): boolean {
  const parsed = ctx.parseUri(uri);
  return parsed?.type === "actor" && parsed.identifier === USER;
}

async function generateStoredKeyPair(type: KeyType): Promise<StoredKeyPair> {
  const { privateKey, publicKey } = await generateCryptoKeyPair(type);
  return {
    privateKey: await exportJwk(privateKey),
    publicKey: await exportJwk(publicKey),
  };
}

async function getStoredKeyPairs(
  kv: Deno.Kv,
  identifier: string,
): Promise<StoredKeyPair[]> {
  const key = ["keys", identifier] as const;
  const entry = await kv.get<StoredKeyPair[]>(key);
  if (entry.value != null) return entry.value;

  const generated = await Promise.all(KEY_TYPES.map(generateStoredKeyPair));
  // atomic w/ versionstamp check: concurrent first fetches must agree on one key set
  const res = await kv.atomic().check(entry).set(key, generated).commit();
  return res.ok ? generated : (await kv.get<StoredKeyPair[]>(key)).value!;
}

async function importStoredKeyPair(pair: StoredKeyPair) {
  return {
    privateKey: await importJwk(pair.privateKey, "private"),
    publicKey: await importJwk(pair.publicKey, "public"),
  };
}

function toRecipient(follower: StoredFollower): Recipient {
  return {
    id: new URL(follower.id),
    inboxId: new URL(follower.inboxId),
  };
}

function buildNote(ctx: Context<void>, post: StoredPost): Note {
  return new Note({
    id: ctx.getObjectUri(Note, { identifier: USER, id: post.id }),
    attribution: ctx.getActorUri(USER),
    content: post.content,
    // public post addressing: to Public, cc followers
    to: PUBLIC_COLLECTION,
    cc: ctx.getFollowersUri(USER),
    published: Temporal.Instant.from(post.published),
  });
}

function buildCreate(ctx: Context<void>, post: StoredPost): Create {
  const note = buildNote(ctx, post);
  return new Create({
    id: new URL(`${note.id!.href}#create`),
    actor: ctx.getActorUri(USER),
    object: note,
    to: PUBLIC_COLLECTION,
    cc: ctx.getFollowersUri(USER),
  });
}

export async function publishPost(
  ctx: Context<void>,
  kv: Deno.Kv,
  content: string,
): Promise<StoredPost> {
  const post: StoredPost = {
    id: crypto.randomUUID(),
    content,
    published: Temporal.Now.instant().toString(),
  };
  await kv.set(postKey(post.id), post);
  // "followers" → Fedify resolves the followers collection and handles queue/retry
  await ctx.sendActivity(
    { identifier: USER },
    "followers",
    buildCreate(ctx, post),
  );
  return post;
}

export async function handleFollow(
  ctx: InboxContext<void>,
  follow: Follow,
  kv: Deno.Kv,
) {
  if (follow.id == null || follow.objectId == null) return;
  if (!isUserActor(ctx, follow.objectId)) return;
  const follower = await follow.getActor(ctx);
  if (follower?.id == null || follower.inboxId == null) return;
  await kv.set(
    followerKey(follower.id.href),
    {
      id: follower.id.href,
      inboxId: follower.inboxId.href,
    } satisfies StoredFollower,
  );
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
  if (!isUserActor(ctx, object.objectId)) return;
  // signature verification upstream guarantees undo.actorId is the sender;
  // the inner Follow's actor must be that same sender
  if (object.actorId?.href !== undo.actorId.href) return;
  await kv.delete(followerKey(undo.actorId.href));
}

export function createFederationInstance(kv: Deno.Kv) {
  const federation = createFederation<void>({
    kv: new DenoKvStore(kv),
    queue: new DenoKvMessageQueue(kv),
  });

  federation
    .setActorDispatcher("/users/{identifier}", async (ctx, identifier) => {
      if (identifier !== USER) return null;
      const keys = await ctx.getActorKeyPairs(identifier);
      return new Person({
        id: ctx.getActorUri(identifier),
        preferredUsername: identifier,
        name: "Deeeeeemo",
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
      return Promise.all((await getStoredKeyPairs(kv, identifier)).map(
        importStoredKeyPair,
      ));
    });

  federation
    .setInboxListeners("/users/{identifier}/inbox", "/inbox")
    .on(Follow, (ctx, follow) => handleFollow(ctx, follow, kv))
    .on(Undo, (ctx, undo) => handleUndo(ctx, undo, kv));

  federation.setOutboxDispatcher(
    "/users/{identifier}/outbox",
    async (ctx, identifier) => {
      if (identifier !== USER) return null;
      const entries = await Array.fromAsync(
        kv.list<StoredPost>({ prefix: postsPrefix }),
      );
      const items = entries
        .map((e) => e.value)
        .sort((a, b) => b.published.localeCompare(a.published))
        .map((post) => buildCreate(ctx, post));
      return { items };
    },
  );

  federation.setObjectDispatcher(
    Note,
    "/users/{identifier}/notes/{id}",
    async (ctx, values) => {
      if (values.identifier !== USER) return null;
      const post = (await kv.get<StoredPost>(postKey(values.id))).value;
      if (post == null) return null;
      return buildNote(ctx, post);
    },
  );

  federation
    .setFollowersDispatcher(
      "/users/{identifier}/followers",
      async (_ctx, identifier, cursor) => {
        if (identifier !== USER) return null;
        // limit+1 probe: only emit nextCursor when a following item really exists
        const iter = kv.list<StoredFollower>(
          { prefix: followersPrefix },
          {
            limit: FOLLOWERS_PAGE_SIZE + 1,
            cursor: cursor || undefined,
          },
        );
        const items: Recipient[] = [];
        let nextCursor: string | null = null;
        let pageCursor = "";
        for await (const entry of iter) {
          if (items.length === FOLLOWERS_PAGE_SIZE) {
            nextCursor = pageCursor;
            break;
          }
          items.push(toRecipient(entry.value));
          pageCursor = iter.cursor;
        }
        return { items, nextCursor };
      },
    )
    .setFirstCursor((_ctx, identifier) => (identifier === USER ? "" : null));

  return federation;
}
