import { beforeEach, describe, expect, it } from "vitest";
import { HindsightClient } from "../src/client";
// Import the mock by path so tsc type-checks against it; vitest aliases
// "obsidian" → this same module, so it's the singleton the client calls.
import { requestUrl } from "./__mocks__/obsidian";

const mock = requestUrl;

function ok(json: unknown = {}) {
  return { status: 200, text: JSON.stringify(json), json };
}

function lastCall() {
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error("requestUrl was not called");
  return call[0];
}

describe("HindsightClient", () => {
  beforeEach(() => {
    mock.mockReset();
    mock.mockImplementation(async (params) =>
      params.url.includes("/operations/")
        ? ok({ operation_id: "op-1", status: "completed", updated_at: "T1" })
        : ok({ operation_id: "op-1" })
    );
  });

  it("retain posts an upsert item with document_id and replace mode", async () => {
    const client = new HindsightClient("https://api.example.com/", "secret");
    await client.retain("bank x", "Folder/Note.md", "body text", { tags: ["t1"] });

    const params = mock.mock.calls[0][0];
    expect(params.method).toBe("POST");
    expect(params.url).toBe("https://api.example.com/v1/default/banks/bank%20x/memories");
    expect(params.headers?.Authorization).toBe("Bearer secret");
    const body = JSON.parse(params.body ?? "{}");
    expect(body.items[0]).toMatchObject({
      content: "body text",
      document_id: "Folder/Note.md",
      update_mode: "replace",
      tags: ["t1"],
    });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("deleteDocument encodes segments but preserves path slashes", async () => {
    const client = new HindsightClient("https://api.example.com");
    await client.deleteDocument("b", "Folder/My Note.md");
    const params = lastCall();
    expect(params.method).toBe("DELETE");
    expect(params.url).toBe(
      "https://api.example.com/v1/default/banks/b/documents/Folder/My%20Note.md"
    );
  });

  it("reflect requests citations + trace when asked", async () => {
    mock.mockResolvedValue(ok({ text: "answer", based_on: { memories: [] } }));
    const client = new HindsightClient("https://api.example.com");
    const res = await client.reflect("b", "what?", { budget: "high", includeCitations: true });

    const body = JSON.parse(mock.mock.calls[0][0].body ?? "{}");
    expect(body).toMatchObject({ query: "what?", budget: "high" });
    expect(body.include).toEqual({ facts: {}, tool_calls: {} });
    expect(res.text).toBe("answer");
  });

  it("omits the Authorization header when no token is set", async () => {
    const client = new HindsightClient("https://api.example.com");
    await client.reflect("b", "q");
    expect(lastCall().headers?.Authorization).toBeUndefined();
  });

  it("throws a useful error on non-2xx", async () => {
    mock.mockResolvedValue({ status: 500, text: "boom", json: {} });
    const client = new HindsightClient("https://api.example.com");
    await expect(client.reflect("b", "q")).rejects.toThrow(/HTTP 500: boom/);
  });

  it("propagates a transport rejection (network/timeout)", async () => {
    mock.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));
    const client = new HindsightClient("https://api.example.com");
    await expect(client.reflect("b", "q")).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
  });

  it("reflect sends tag_groups when provided", async () => {
    const client = new HindsightClient("https://api.example.com");
    await client.reflect("b", "q", {
      tagGroups: [{ tags: ["vault:notes"], match: "all_strict" }],
      tags: ["ignored"],
    });
    const body = JSON.parse(lastCall().body ?? "{}");
    expect(body.tag_groups).toEqual([{ tags: ["vault:notes"], match: "all_strict" }]);
    expect(body.tags).toBeUndefined();
  });

  it("reflect falls back to tags when only tags are given", async () => {
    const client = new HindsightClient("https://api.example.com");
    await client.reflect("b", "q", { tags: ["work"] });
    const body = JSON.parse(lastCall().body ?? "{}");
    expect(body.tags).toEqual(["work"]);
    expect(body.tag_groups).toBeUndefined();
  });

  it("reflect sends neither tags nor tag_groups when both are empty", async () => {
    const client = new HindsightClient("https://api.example.com");
    await client.reflect("b", "q", { tags: [], tagGroups: [] });
    const body = JSON.parse(lastCall().body ?? "{}");
    expect(body.tags).toBeUndefined();
    expect(body.tag_groups).toBeUndefined();
  });

  it("retain omits the tags field when no tags are given", async () => {
    const client = new HindsightClient("https://api.example.com");
    await client.retain("b", "Note.md", "body");
    const body = JSON.parse(mock.mock.calls[0][0].body ?? "{}");
    expect(body.items[0].tags).toBeUndefined();
  });

  it("retain sends observation scopes and waits for terminal completion", async () => {
    const client = new HindsightClient("https://api.example.com", undefined, 0, 1_000);
    const result = await client.retain("b", "Note.md", "body", {
      observationScopes: [["source:obsidian", "vault:Main", "lifecycle:current"]],
    });
    const firstBody = JSON.parse(mock.mock.calls[0][0].body ?? "{}");
    expect(firstBody.items[0].observation_scopes).toEqual([
      ["source:obsidian", "vault:Main", "lifecycle:current"],
    ]);
    expect(result).toEqual({ operationId: "op-1", status: "completed", completedAt: "T1" });
  });

  it("does not report retain success when the async operation fails", async () => {
    mock.mockImplementation(async (params) =>
      params.url.includes("/operations/")
        ? ok({ operation_id: "op-1", status: "failed", error: "extractor failed" })
        : ok({ operation_id: "op-1" })
    );
    const client = new HindsightClient("https://api.example.com", undefined, 0, 1_000);
    await expect(client.retain("b", "Note.md", "body")).rejects.toThrow(
      /operation op-1 failed/
    );
  });
});
