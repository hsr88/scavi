import { describe, expect, it, vi } from "vitest";
import { OllamaProvider, OpenAIResponsesProvider } from "../src/index.js";

describe("OpenAIResponsesProvider", () => {
  it("sends only the claim and retrieved evidence with structured output", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.store).toBe(false);
      expect(body.text.format.type).toBe("json_schema");
      expect(JSON.parse(body.input)).toEqual({ claim: "Settings use SQLite", evidence: [{ file: "src/storage.ts", startLine: 1, endLine: 2, content: "openSqlite()" }] });
      return new Response(JSON.stringify({ output_text: JSON.stringify({ verdict: "consistent", confidence: 0.91, reason: "SQLite storage is present." }) }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new OpenAIResponsesProvider({ apiKey: "test-key", model: "test-model", fetcher: fetcher as typeof fetch });
    await expect(provider.verify({ claim: "Settings use SQLite", evidence: [{ file: "src/storage.ts", startLine: 1, endLine: 2, content: "openSqlite()", score: 2 }] })).resolves.toEqual({ verdict: "consistent", confidence: 0.91, reason: "SQLite storage is present." });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects malformed provider output", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ output_text: "{}" }), { status: 200 }));
    const provider = new OpenAIResponsesProvider({ apiKey: "test-key", model: "test-model", fetcher: fetcher as typeof fetch });
    await expect(provider.verify({ claim: "claim", evidence: [] })).rejects.toThrow("invalid verdict");
  });
});

describe("OllamaProvider", () => {
  it("uses the local chat API without an API key", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://localhost:11434/api/chat");
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(false);
      expect(body.options.temperature).toBe(0);
      expect(body.format.required).toEqual(["verdict", "confidence", "reason"]);
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ verdict: "uncertain", confidence: 0.4, reason: "Evidence is incomplete." }) } }), { status: 200 });
    });
    const provider = new OllamaProvider({ model: "local-model", fetcher: fetcher as typeof fetch });
    await expect(provider.verify({ claim: "claim", evidence: [] })).resolves.toMatchObject({ verdict: "uncertain", confidence: 0.4 });
  });
});
