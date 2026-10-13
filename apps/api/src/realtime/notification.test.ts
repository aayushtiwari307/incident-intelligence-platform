import assert from "node:assert/strict";
import { organizationRoom, parseEventNotification } from "./notification";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("parseEventNotification", () => {
  it("accepts the trigger's payload", () => {
    assert.deepEqual(parseEventNotification(JSON.stringify({ id: 42, o: ORG })), { eventId: 42, organizationId: ORG });
  });

  it("normalises the organization id to lower case (it becomes part of a room name)", () => {
    assert.equal(parseEventNotification(JSON.stringify({ id: 1, o: ORG.toUpperCase() }))?.organizationId, ORG);
  });

  it.each([
    ["not json", "{"],
    ["an array", "[1,2]"],
    ["null", "null"],
    ["a string id", JSON.stringify({ id: "1", o: ORG })],
    ["a zero id", JSON.stringify({ id: 0, o: ORG })],
    ["a negative id", JSON.stringify({ id: -3, o: ORG })],
    ["a fractional id", JSON.stringify({ id: 1.5, o: ORG })],
    ["an unsafe integer", `{"id":9007199254740993,"o":"${ORG}"}`],
    ["a missing organization", JSON.stringify({ id: 1 })],
    ["a non-uuid organization", JSON.stringify({ id: 1, o: "org:evil" })],
    ["an organization with a room-injection suffix", JSON.stringify({ id: 1, o: `${ORG}:x` })],
    ["an oversized payload", JSON.stringify({ id: 1, o: ORG, pad: "x".repeat(300) })],
  ])("rejects %s", (_name, raw) => {
    assert.equal(parseEventNotification(raw), null);
  });
});

describe("organizationRoom", () => {
  it("has a single, fixed format", () => {
    assert.equal(organizationRoom(ORG), `org:${ORG}`);
  });
});
