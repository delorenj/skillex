import assert from "node:assert/strict";
import { hostname } from "node:os";
import test from "node:test";
import { hostIdentity, localHostIdentities, resolveHostIdentity } from "@delorenj/skillex";

const UUID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

test("macOS names the machine by IOPlatformUUID, not the DHCP/Bonjour hostname", () => {
  const sources = (name) => ({
    platform: "darwin",
    hostname: () => name,
    platformUuid: () => UUID,
  });
  const before = resolveHostIdentity(sources("Mac.attlocal.net"));
  const after = resolveHostIdentity(sources("HelloSub.local"));
  assert.equal(before, `darwin:${UUID.toUpperCase()}`);
  assert.equal(after, before, "a hostname change on the same Mac must not change its identity");
});

test("macOS without a readable UUID keeps the hostname", () => {
  assert.equal(
    resolveHostIdentity({
      platform: "darwin",
      hostname: () => "HelloSub.local",
      platformUuid: () => null,
    }),
    "HelloSub.local",
  );
  assert.equal(
    resolveHostIdentity({
      platform: "darwin",
      hostname: () => "HelloSub.local",
      platformUuid: () => "not-a-uuid",
    }),
    "HelloSub.local",
  );
});

test("Linux identity is the hostname, byte for byte as before", () => {
  assert.equal(
    resolveHostIdentity({
      platform: "linux",
      hostname: () => "big-chungus",
      platformUuid: () => UUID,
    }),
    "big-chungus",
  );
  if (process.platform !== "darwin") {
    assert.equal(hostIdentity(), hostname());
    assert.deepEqual(localHostIdentities(), [hostname()]);
  }
});

test("records written by earlier releases (bare hostname) stay local", () => {
  const local = localHostIdentities();
  assert.ok(local.includes(hostIdentity()));
  assert.ok(local.includes(hostname()));
  assert.ok(!local.includes(`${hostname()}-foreign`));
});
