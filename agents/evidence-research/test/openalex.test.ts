import { describe, expect, it, vi } from "vitest";
import { OpenAlexClient, reconstructAbstract } from "../src/openalex.js";

describe("OpenAlexClient", () => {
  it("validates and normalizes search results", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W1",
              title: "Reliable Agents",
              doi: "https://doi.org/10.1/agents",
              publication_year: 2025,
              authorships: [{ author: { display_name: "Ada Researcher" } }],
              primary_location: { landing_page_url: "https://example.test/paper" },
              abstract_inverted_index: { Reliable: [0], agents: [1], matter: [2] },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new OpenAlexClient({ fetch: fetchMock });

    const sources = await client.search({ query: "reliable agents", limit: 5, yearFrom: 2020 });

    expect(sources).toEqual([
      expect.objectContaining({
        id: "https://openalex.org/W1",
        abstract: "Reliable agents matter",
        authors: ["Ada Researcher"],
      }),
    ]);
    const requestedUrl = fetchMock.mock.calls[0]?.[0];
    expect(String(requestedUrl)).toContain("from_publication_date%3A2020-01-01");
  });

  it("reconstructs an abstract by word positions", () => {
    expect(reconstructAbstract({ world: [1], Hello: [0] })).toBe("Hello world");
  });
});
