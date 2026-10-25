// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class CheckoutLockError extends Data.TaggedError("CheckoutLockError")<{
  readonly message: string;
}> {}

/** Cooperating environments share the checkout's Git directory, including for subprojects. */
export function withCheckoutLock<A, E, R>(gitDirectory: string, work: Effect.Effect<A, E, R>) {
  const acquire = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.tryPromise({
      try: async () => {
        const directory = await NodeFSP.realpath(gitDirectory);
        const path = NodePath.join(directory, "t3-codebase-write.lock");
        const token = `${process.pid}:${NodeCrypto.randomUUID()}`;
        const open = () => NodeFSP.open(path, "wx");
        const handle = await open().catch(async () => {
          const stat = await NodeFSP.lstat(path);
          if (stat.isSymbolicLink()) throw new Error("The checkout lock is a symbolic link.");
          const owner = await NodeFSP.readFile(path, "utf8");
          const pid = Number(owner.split(":")[0]);
          let alive = Number.isSafeInteger(pid) && pid > 0;
          if (Number.isSafeInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch (cause) {
              alive = !(
                typeof cause === "object" &&
                cause !== null &&
                "code" in cause &&
                cause.code === "ESRCH"
              );
            }
          }
          if (
            !alive &&
            now - stat.mtimeMs > 300_000 &&
            (await NodeFSP.readFile(path, "utf8")) === owner
          ) {
            await NodeFSP.unlink(path);
            return open();
          }
          throw new Error(
            "Another T3 operation is updating this checkout. Retry after it finishes.",
          );
        });
        await handle.writeFile(token);
        return async () => {
          await handle.close();
          if ((await NodeFSP.readFile(path, "utf8").catch(() => null)) === token)
            await NodeFSP.unlink(path);
        };
      },
      catch: (cause) => new CheckoutLockError({ message: String(cause) }),
    });
  });
  return Effect.acquireUseRelease(
    acquire,
    () => work,
    (release) => Effect.promise(release),
  );
}
