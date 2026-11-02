export const BRIDGE_PATH = "/__threadside/bridge.js";

/**
 * The upstream URL for a proxied request. Only the path and query are taken from the request and
 * the origin is always the server's, so a path such as `//other.host/x` can never send the bearer
 * token anywhere else.
 */
export function upstreamUrl(httpBaseUrl: string, request: URL): URL {
  const upstream = new URL(httpBaseUrl);
  upstream.pathname = request.pathname.replace(/^\/+/, "/");
  upstream.search = request.search;
  upstream.hash = "";
  return upstream;
}

/** Loads the bridge before the app's own module so it can observe clicks and keys first. */
export function injectBridge(html: string): string {
  const tag = `<script src="${BRIDGE_PATH}"></script>`;
  if (html.includes(BRIDGE_PATH)) return html;
  const head = html.search(/<head[^>]*>/i);
  if (head < 0) return tag + html;
  const end = html.indexOf(">", head) + 1;
  return html.slice(0, end) + tag + html.slice(end);
}
