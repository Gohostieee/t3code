// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { withCheckoutLock } from "./CheckoutLock.ts";

it.live("excludes a second writer and releases the lock after a failed write", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-checkout-lock-"))),
        (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const owner = yield* withCheckoutLock(
        directory,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.fail("write-failed")),
        ),
      ).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      expect(
        (yield* Effect.result(withCheckoutLock(directory, Effect.succeed("unexpected"))))._tag,
      ).toBe("Failure");
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(owner))._tag).toBe("Failure");
      expect(yield* withCheckoutLock(directory, Effect.succeed("accepted"))).toBe("accepted");
      expect(yield* Effect.promise(() => NodeFSP.readdir(directory))).toEqual([]);
    }),
  ),
);
