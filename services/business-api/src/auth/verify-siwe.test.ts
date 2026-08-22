import { beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import { SiweMessage, generateNonce } from "siwe";
import { verifySiwe } from "./verify-siwe.js";
import { AuthApiError } from "./errors.js";
import type { NonceStore } from "./nonce-store.js";
import type { SessionRecord, SessionStore } from "./session-store.js";
import type { SiweConfig } from "./siwe-config.js";

const CONFIG: SiweConfig = {
  expectedDomain: "app.example.com",
  expectedUri: "https://app.example.com/login",
  expectedChainId: 1,
};

const NOW = new Date("2026-08-22T12:00:00.000Z");

function makeNonceStore(nonce: string): { store: NonceStore; consume: ReturnType<typeof vi.fn> } {
  const consume = vi.fn(async (n: string) => n === nonce);
  const store: NonceStore = {
    issue: vi.fn(async () => ({ nonce, expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000) })),
    consume,
  };
  return { store, consume };
}

function makeSessionStore(): { store: SessionStore; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async (walletAddress: string): Promise<SessionRecord> => ({
    sessionId: "session-1",
    walletAddress,
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
  }));
  const store: SessionStore = { create, findValid: vi.fn(async () => null) };
  return { store, create };
}

async function signMessage(wallet: Wallet, overrides: Partial<SiweMessage> = {}, nonce = generateNonce()) {
  const message = new SiweMessage({
    domain: CONFIG.expectedDomain,
    address: wallet.address,
    uri: CONFIG.expectedUri,
    version: "1",
    chainId: CONFIG.expectedChainId,
    nonce,
    issuedAt: NOW.toISOString(),
    ...overrides,
  });
  const preparedMessage = message.prepareMessage();
  const signature = await wallet.signMessage(preparedMessage);
  return { message: preparedMessage, signature, nonce };
}

describe("verifySiwe", () => {
  let wallet: Wallet;

  beforeEach(() => {
    wallet = Wallet.createRandom() as unknown as Wallet;
  });

  it("creates a session for a validly signed message bound to nonce/domain/uri/chainId", async () => {
    const { message, signature, nonce } = await signMessage(wallet);
    const { store: nonceStore, consume } = makeNonceStore(nonce);
    const { store: sessionStore, create } = makeSessionStore();

    const session = await verifySiwe(
      { nonceStore, sessionStore, config: CONFIG, now: () => NOW },
      { message, signature },
    );

    expect(session.walletAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(consume).toHaveBeenCalledWith(nonce);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects a message whose domain does not match the expected domain (cross-site reuse)", async () => {
    const { message, signature } = await signMessage(wallet, { domain: "evil.example.com" });
    const { store: nonceStore, consume } = makeNonceStore("does-not-matter");
    const { store: sessionStore } = makeSessionStore();

    await expect(
      verifySiwe({ nonceStore, sessionStore, config: CONFIG, now: () => NOW }, { message, signature }),
    ).rejects.toBeInstanceOf(AuthApiError);
    expect(consume).not.toHaveBeenCalled();
  });

  it("rejects a message whose uri does not match the expected uri", async () => {
    const { message, signature } = await signMessage(wallet, { uri: "https://app.example.com/other" });
    const { store: nonceStore } = makeNonceStore("does-not-matter");
    const { store: sessionStore } = makeSessionStore();

    await expect(
      verifySiwe({ nonceStore, sessionStore, config: CONFIG, now: () => NOW }, { message, signature }),
    ).rejects.toBeInstanceOf(AuthApiError);
  });

  it("rejects a message whose chainId does not match the expected chainId", async () => {
    const { message, signature } = await signMessage(wallet, { chainId: 137 });
    const { store: nonceStore } = makeNonceStore("does-not-matter");
    const { store: sessionStore } = makeSessionStore();

    await expect(
      verifySiwe({ nonceStore, sessionStore, config: CONFIG, now: () => NOW }, { message, signature }),
    ).rejects.toBeInstanceOf(AuthApiError);
  });

  it("rejects when the signature does not match the claimed address (tampered/forged)", async () => {
    const { message } = await signMessage(wallet);
    const otherWallet = Wallet.createRandom() as unknown as Wallet;
    const forgedSignature = await otherWallet.signMessage(message);
    const { store: nonceStore, consume } = makeNonceStore("does-not-matter");
    const { store: sessionStore } = makeSessionStore();

    await expect(
      verifySiwe(
        { nonceStore, sessionStore, config: CONFIG, now: () => NOW },
        { message, signature: forgedSignature },
      ),
    ).rejects.toBeInstanceOf(AuthApiError);
    expect(consume).not.toHaveBeenCalled();
  });

  it("rejects when the nonce was already consumed (replay)", async () => {
    const { message, signature, nonce } = await signMessage(wallet);
    const nonceStore: NonceStore = {
      issue: vi.fn(async () => ({ nonce, expiresAt: NOW })),
      consume: vi.fn(async () => false), // already consumed / unknown / expired
    };
    const { store: sessionStore, create } = makeSessionStore();

    await expect(
      verifySiwe({ nonceStore, sessionStore, config: CONFIG, now: () => NOW }, { message, signature }),
    ).rejects.toBeInstanceOf(AuthApiError);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an expired message (expirationTime in the past)", async () => {
    const { message, signature, nonce } = await signMessage(wallet, {
      expirationTime: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    const { store: nonceStore } = makeNonceStore(nonce);
    const { store: sessionStore } = makeSessionStore();

    await expect(
      verifySiwe({ nonceStore, sessionStore, config: CONFIG, now: () => NOW }, { message, signature }),
    ).rejects.toBeInstanceOf(AuthApiError);
  });

  it("rejects malformed input (missing message/signature)", async () => {
    const { store: nonceStore } = makeNonceStore("n");
    const { store: sessionStore } = makeSessionStore();

    await expect(
      verifySiwe(
        { nonceStore, sessionStore, config: CONFIG, now: () => NOW },
        { message: undefined, signature: "0xdead" },
      ),
    ).rejects.toBeInstanceOf(AuthApiError);
    await expect(
      verifySiwe(
        { nonceStore, sessionStore, config: CONFIG, now: () => NOW },
        { message: "not a real siwe message", signature: "0xdead" },
      ),
    ).rejects.toBeInstanceOf(AuthApiError);
  });
});
