import { describe, it, expect } from "vitest";
import { createEncryption } from "../../src/lib/encryption.js";
import { createUserApiKeys } from "../../src/lib/user-api-key.js";
import { createEntityApiKeyFormat } from "../../src/lib/entity-api-key.js";

const encryption = createEncryption(
  () => "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
);
const header = (value: string) => (name: string) =>
  name === "X-API-Key" ? value : undefined;

describe("injected key prefixes", () => {
  const shyft = createUserApiKeys({ prefix: "shyft_", encryption });
  const shroute = createUserApiKeys({ prefix: "shroute_", encryption });

  it("generates keys with the configured user prefix", () => {
    expect(shyft.generateUserApiKey().key.startsWith("shyft_")).toBe(true);
    expect(shroute.generateUserApiKey().key.startsWith("shroute_")).toBe(true);
  });

  it("does not accept another product's user key", () => {
    expect(shyft.extractUserApiKeyFromHeaders(header("shroute_abc"))).toBeNull();
    expect(shroute.extractUserApiKeyFromHeaders(header("shyft_abc"))).toBeNull();
    expect(shroute.extractUserApiKeyFromHeaders(header("shroute_abc"))).toBe(
      "shroute_abc"
    );
  });

  it("does not accept another product's entity key", () => {
    const shyftEnt = createEntityApiKeyFormat("shyftent");
    const shrouteEnt = createEntityApiKeyFormat("shrouteent");
    expect(
      shyftEnt.extractEntityApiKeyFromHeaders(header("shrouteent_abc"))
    ).toBeNull();
    expect(
      shrouteEnt.extractEntityApiKeyFromHeaders(header("shrouteent_abc"))
    ).toBe("shrouteent_abc");
  });
});
