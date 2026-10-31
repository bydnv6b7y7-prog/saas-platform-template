import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader, setResponseHeader } from "@tanstack/react-start/server";

import { getApiBaseURL } from "./api-url";
import { readSessionUser } from "./session-user.server";

export const getRequestSessionUser = createServerFn({ method: "GET" }).handler(() => {
  setResponseHeader("Cache-Control", "private, no-store");
  return readSessionUser(getApiBaseURL(), getRequestHeader("cookie"));
});
