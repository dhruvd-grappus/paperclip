import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createApiProxy } from "./vite-api-proxy";

describe("createApiProxy", () => {
  function fireProxyReq(req: {
    headers: Record<string, string | string[] | undefined>;
    socket?: { encrypted?: boolean };
  }) {
    const proxy = createApiProxy();
    const proxyEmitter = new EventEmitter();
    proxy["/api"].configure!(proxyEmitter as never, {} as never);
    const setHeader = vi.fn();
    proxyEmitter.emit("proxyReq", { setHeader }, { socket: {}, ...req });
    return setHeader;
  }

  it("proxies /api to the given target with ws support", () => {
    const proxy = createApiProxy("http://example.local:9999");
    expect(proxy["/api"].target).toBe("http://example.local:9999");
    expect(proxy["/api"].ws).toBe(true);
  });

  it("injects x-forwarded-host and defaults x-forwarded-proto to http on plain sockets", () => {
    const setHeader = fireProxyReq({ headers: { host: "dev-box.tail1234.ts.net:3101" } });
    expect(setHeader).toHaveBeenCalledWith("x-forwarded-host", "dev-box.tail1234.ts.net:3101");
    expect(setHeader).toHaveBeenCalledWith("x-forwarded-proto", "http");
  });

  it("derives x-forwarded-proto=https when the client socket is TLS", () => {
    const setHeader = fireProxyReq({
      headers: { host: "app.example.com" },
      socket: { encrypted: true },
    });
    expect(setHeader).toHaveBeenCalledWith("x-forwarded-proto", "https");
  });

  it("preserves an upstream x-forwarded-proto header from an HTTPS tunnel", () => {
    const setHeader = fireProxyReq({
      headers: { host: "abcd.ngrok.app", "x-forwarded-proto": "https" },
    });
    expect(setHeader).toHaveBeenCalledWith("x-forwarded-proto", "https");
  });

  it("skips forwarding headers when the client sends no Host", () => {
    const setHeader = fireProxyReq({ headers: {} });
    expect(setHeader).not.toHaveBeenCalled();
  });

  describe("PAPERCLIP_PREVIEW_API_ORIGIN", () => {
    afterEach(() => {
      delete process.env.PAPERCLIP_PREVIEW_API_ORIGIN;
    });

    it("presents the configured origin and forwarded host upstream", () => {
      process.env.PAPERCLIP_PREVIEW_API_ORIGIN = "https://board.example.test";
      const setHeader = fireProxyReq({
        headers: { host: "gra-1.preview.example.test", referer: "https://gra-1.preview.example.test/login?next=/" },
      });
      expect(setHeader).toHaveBeenCalledWith("origin", "https://board.example.test");
      expect(setHeader).toHaveBeenCalledWith("x-forwarded-host", "board.example.test");
      expect(setHeader).toHaveBeenCalledWith("x-forwarded-proto", "https");
      // The path survives so the guard still sees which page mutated.
      expect(setHeader).toHaveBeenCalledWith("referer", "https://board.example.test/login?next=/");
    });

    it("asserts the origin even when the client sends no Host", () => {
      process.env.PAPERCLIP_PREVIEW_API_ORIGIN = "https://board.example.test";
      const setHeader = fireProxyReq({ headers: {} });
      expect(setHeader).toHaveBeenCalledWith("origin", "https://board.example.test");
    });

    it("ignores an unparseable value and keeps the plain forwarding behaviour", () => {
      process.env.PAPERCLIP_PREVIEW_API_ORIGIN = "not a url";
      const setHeader = fireProxyReq({ headers: { host: "gra-1.preview.example.test" } });
      expect(setHeader).toHaveBeenCalledWith("x-forwarded-host", "gra-1.preview.example.test");
      expect(setHeader).not.toHaveBeenCalledWith("origin", expect.anything());
    });
  });
});
