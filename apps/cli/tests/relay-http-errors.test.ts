import { expect, test } from "bun:test";

import { relayHttpError } from "../src/cli/auth/relay-http-errors.ts";

const edgeHeaders = {
  server: "cloudflare",
  "cf-ray": "a51cd4c2cc301849-BOM",
};

test.each([401, 403, 429, 500, 503])("classifies HTTP %s without a thrown exception", (status) => {
  expect(relayHttpError(status)).toEqual({ errorType: "HTTPError", errorCode: `HTTP_${status}` });
});

test("recognizes Cloudflare's explicit browser challenge header", () => {
  expect(relayHttpError(403, new Headers({ "cf-mitigated": " Challenge " }))).toEqual({
    errorType: "CloudflareError",
    errorCode: "CLOUDFLARE_CHALLENGE",
  });
});

test("recognizes likely Cloudflare HTML denial pages from status and edge headers", () => {
  expect(
    relayHttpError(
      403,
      new Headers({
        ...edgeHeaders,
        server: "Cloudflare",
        "content-type": "Text/HTML; charset=UTF-8",
      }),
    ),
  ).toEqual({ errorType: "CloudflareError", errorCode: "CLOUDFLARE_HTML_DENIAL" });
});

test.each([
  [403, { ...edgeHeaders, "content-type": "application/json" }],
  [403, { ...edgeHeaders, "content-type": "text/event-stream" }],
  [403, { ...edgeHeaders, "content-type": "text/html-invalid" }],
  [403, { server: "cloudflare", "content-type": "text/html" }],
  [403, { "cf-ray": edgeHeaders["cf-ray"], "content-type": "text/html" }],
  [403, { "content-type": "text/html" }],
  [503, { ...edgeHeaders, "content-type": "text/html" }],
] as const)(
  "does not mislabel ordinary HTTP %s failures as Cloudflare blocks (%j)",
  (status, headers) => {
    expect(relayHttpError(status, new Headers(headers))).toEqual({
      errorType: "HTTPError",
      errorCode: `HTTP_${status}`,
    });
  },
);

test.each([200, 204, 302])("leaves successful/redirect HTTP %s responses alone", (status) => {
  expect(relayHttpError(status, new Headers(edgeHeaders))).toBeUndefined();
});
