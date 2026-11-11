// Shared test helpers: an in-memory MCP client connected to a server over a fixture data dir.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DataDir } from "../src/data-dir.mjs";
import { createServer, DISCLAIMER } from "../src/server.mjs";
import { buildFixture } from "./fixture.mjs";

export { DISCLAIMER };

export async function connect(dir, limits) {
  const server = createServer({ dataDir: new DataDir(dir, limits) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  const raw = (name, args = {}) => client.callTool({ name, arguments: args });
  /** Call a tool and parse its JSON body (the text before the disclaimer). */
  const call = async (name, args = {}) => {
    const res = await raw(name, args);
    const text = res.content[0].text;
    if (!text.endsWith(DISCLAIMER)) throw new Error(`response without disclaimer: ${text.slice(-80)}`);
    const body = text.slice(0, -DISCLAIMER.length).trim();
    if (res.isError) return { error: body, isError: true };
    return JSON.parse(body);
  };
  return { client, server, call, raw, close: async () => { await client.close(); await server.close(); } };
}

export async function fixtureClient() {
  const fx = await buildFixture();
  const c = await connect(fx.dir);
  return { fx, ...c };
}
