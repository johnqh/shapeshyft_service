import { describe, it, expect } from "vitest";
import { publicProject } from "../../src/lib/public-project.js";

describe("publicProject", () => {
  const row = {
    uuid: "p-1",
    project_name: "sider",
    display_name: "Sider",
    is_active: true,
    api_key_prefix: "sk_live_FZUo",
    encrypted_api_key: "9efbc1bfc4b68e774263d44243b66195",
    api_key_iv: "9b90935de6f9914dc3cc6449de5df2f5",
  };

  it("withholds the ciphertext and its IV", () => {
    // Encrypted is not the same as safe to hand out: ciphertext plus IV is
    // strictly more than a caller needs to identify a project.
    const out = publicProject(row) as Record<string, unknown>;
    expect(out.encrypted_api_key).toBeUndefined();
    expect(out.api_key_iv).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("9efbc1bf");
    expect(JSON.stringify(out)).not.toContain("9b909");
  });

  it("keeps everything a caller legitimately uses", () => {
    // api_key_prefix is how a project's key is identified in a listing, so
    // removing it would break the thing the ciphertext was standing in for.
    const out = publicProject(row) as Record<string, unknown>;
    expect(out).toMatchObject({
      uuid: "p-1",
      project_name: "sider",
      display_name: "Sider",
      is_active: true,
      api_key_prefix: "sk_live_FZUo",
    });
  });

  it("tolerates a row that has no key yet", () => {
    expect(publicProject({ uuid: "p-2", project_name: "x" })).toEqual({ uuid: "p-2", project_name: "x" });
  });
});
