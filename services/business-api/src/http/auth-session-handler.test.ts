import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { createAuthLogoutHandler, createAuthSessionHandler } from "./auth-session-handler";

describe("auth session handler", () => {
  it("returns the authenticated wallet without exposing the opaque session id", async () => {
    const response = await createAuthSessionHandler({
      allowedOrigin: "http://localhost:3001",
      resolveActorId: async () => "0x1111111111111111111111111111111111111111",
    })(new Request("http://api.local/api/auth/session"));
    expect(await response.json()).toEqual({ authenticated: true, walletAddress: "0x1111111111111111111111111111111111111111" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("distinguishes an invalid session from an authentication service outage", async () => {
    const unauthenticated = createAuthSessionHandler({ allowedOrigin: "http://localhost:3001", resolveActorId: async () => { throw new SessionInvalidError(); } });
    const unavailable = createAuthSessionHandler({ allowedOrigin: "http://localhost:3001", resolveActorId: async () => { throw new Error("db down"); } });
    await expect(unauthenticated(new Request("http://api.local"))).resolves.toMatchObject({ status: 401 });
    await expect(unavailable(new Request("http://api.local"))).resolves.toMatchObject({ status: 503 });
  });
});

describe("auth logout handler", () => {
  it("revokes the opaque session and clears the httpOnly cookie", async () => {
    const revokeSession = vi.fn(async () => undefined);
    const response = await createAuthLogoutHandler({
      allowedOrigin: "http://localhost:3001",
      revokeSession,
    })(new Request("http://api.local/api/auth/session", {
      method: "DELETE",
      headers: { cookie: "session_id=session-to-revoke" },
    }));

    expect(response.status).toBe(204);
    expect(revokeSession).toHaveBeenCalledWith("session-to-revoke");
    expect(response.headers.get("set-cookie")).toContain("session_id=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("is idempotent when no session cookie exists", async () => {
    const revokeSession = vi.fn(async () => undefined);
    const response = await createAuthLogoutHandler({
      allowedOrigin: "http://localhost:3001",
      revokeSession,
    })(new Request("http://api.local/api/auth/session", { method: "DELETE" }));

    expect(response.status).toBe(204);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("does not clear the cookie when server-side revocation fails", async () => {
    const response = await createAuthLogoutHandler({
      allowedOrigin: "http://localhost:3001",
      revokeSession: async () => { throw new Error("database unavailable"); },
    })(new Request("http://api.local/api/auth/session", {
      method: "DELETE",
      headers: { cookie: "session_id=session-1" },
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject({ error_code: "AUTH_SERVICE_UNAVAILABLE", retryable: true });
  });
});
