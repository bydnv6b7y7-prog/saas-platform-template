import { afterEach, describe, expect, test } from "bun:test";

import { getApiBaseURL } from "./api-url";

const originalServerURL = process.env.SERVER_URL;

afterEach(() => {
  if (originalServerURL === undefined) delete process.env.SERVER_URL;
  else process.env.SERVER_URL = originalServerURL;
});

describe("API base URL", () => {
  test("uses the service-network URL during SSR and trims one trailing slash", () => {
    process.env.SERVER_URL = "http://server:3000/";
    expect(getApiBaseURL()).toBe("http://server:3000");
  });

  test("rejects non-HTTP service URLs", () => {
    process.env.SERVER_URL = "file:///tmp/api";
    expect(() => getApiBaseURL()).toThrow("absolute http(s) URL");
  });
});
