import assert from "node:assert/strict";
import test from "node:test";

import { resetFreshLocalChainCursor } from "./local-chain-bootstrap.mjs";

const validEnvironment = {
	AICP_LOCAL_DEMO_MODE: "true",
	DATABASE_URL: "postgres://aicp:aicp@127.0.0.1:55432/aicp",
	ESCROW_CHAIN_ID: "31337",
	ESCROW_CONTRACT_ADDRESS: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
};

test("resets only the exact Anvil chain and deployed contract cursor", async () => {
	const calls = [];
	const count = await resetFreshLocalChainCursor(validEnvironment, {
		query: async (text, values) => {
			calls.push({ text, values });
			return { rowCount: 1 };
		},
	});
	assert.equal(count, 1);
	assert.equal(calls.length, 1);
	assert.match(calls[0].text, /DELETE FROM chain_event_cursor/);
	assert.deepEqual(calls[0].values, ["31337", validEnvironment.ESCROW_CONTRACT_ADDRESS]);
});

test("rejects remote databases before issuing a delete", async () => {
	let called = false;
	await assert.rejects(
		resetFreshLocalChainCursor({ ...validEnvironment, DATABASE_URL: "postgres://aicp:aicp@db.example.com/aicp" }, {
			query: async () => { called = true; return { rowCount: 0 }; },
		}),
		/loopback/,
	);
	assert.equal(called, false);
});
