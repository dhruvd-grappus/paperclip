import type { ProxyOptions } from "vite";

// Shared /api proxy used by both the vite dev server and `vite preview`.
// The `configure` hook forwards the client's original Host as
// x-forwarded-host so the paperclip server's board mutation guard treats
// the browser's Origin as trusted when the SPA is served from a different
// port than the API (e.g. `pnpm dev:mobile` on :3101 → API on :3100).
//
// `PAPERCLIP_PREVIEW_API_ORIGIN` covers the case the forwarding above cannot:
// a preview served from a hostname the API server does not know. Better Auth
// answers `INVALID_ORIGIN` to any request whose Origin is outside the server's
// `allowedHostnames`, so a throwaway preview host cannot sign in against a
// running server without an operator adding that host and restarting it. Set
// this to an origin the server already trusts and the proxy presents that
// origin (and forwarded host) upstream on the browser's behalf — the session
// cookie still belongs to the preview host, so the preview gets its own login
// against the real API and data. Off unless set: it makes the proxy assert an
// origin the browser did not use, which is only safe for a preview whose
// upstream you control.
export function createApiProxy(target = "http://localhost:3100"): Record<string, ProxyOptions> {
  const assertedOrigin = process.env.PAPERCLIP_PREVIEW_API_ORIGIN?.trim();
  const asserted = assertedOrigin
    ? (() => {
      try {
        return new URL(assertedOrigin);
      } catch {
        return null;
      }
    })()
    : null;

  return {
    "/api": {
      target,
      ws: true,
      configure: (proxy) => {
        proxy.on("proxyReq", (proxyReq, req) => {
          if (asserted) {
            // Origin and forwarded host must agree: the server's board
            // mutation guard trusts the forwarded host, and Better Auth
            // checks Origin against its own allowlist. Referer carries the
            // browser's path, which the guard also accepts as evidence.
            proxyReq.setHeader("origin", asserted.origin);
            proxyReq.setHeader("x-forwarded-host", asserted.host);
            proxyReq.setHeader("x-forwarded-proto", asserted.protocol.replace(":", ""));
            const referer = req.headers.referer;
            if (referer) {
              try {
                const url = new URL(referer);
                proxyReq.setHeader("referer", `${asserted.origin}${url.pathname}${url.search}`);
              } catch {
                proxyReq.setHeader("referer", asserted.origin);
              }
            }
            return;
          }
          const originalHost = req.headers.host;
          if (!originalHost) return;
          proxyReq.setHeader("x-forwarded-host", originalHost);
          // Prefer an upstream x-forwarded-proto (an HTTPS tunnel such as
          // ngrok or tailscale funnel terminates TLS and forwards HTTP to
          // vite with the header set). Fall back to the socket's TLS state.
          const upstreamProto = req.headers["x-forwarded-proto"];
          const proto = Array.isArray(upstreamProto) ? upstreamProto[0] : upstreamProto;
          const isTls = (req.socket as { encrypted?: boolean }).encrypted === true;
          proxyReq.setHeader("x-forwarded-proto", proto ?? (isTls ? "https" : "http"));
        });
      },
    },
  };
}
