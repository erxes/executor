import { makeCloudflareApp } from "./app";
import {
  cloudflareAccessConfigErrorMessage,
  missingCloudflareAccessVars,
  type CloudflareEnv,
} from "./config";

// The MCP Durable Object classes, bound in wrangler.jsonc. They must be exported
// at the Worker entry module scope for the runtime to find them.
export { McpExecutionOwnerDirectoryDO, McpSessionDO } from "./mcp";

// ---------------------------------------------------------------------------
// The Worker fetch entry. Most requests go to `ExecutorApp.make`'s Effect web
// handler. `/mcp` stays at this edge boundary because `McpAgent.serve()` needs
// the Cloudflare `ExecutionContext` to pass authenticated session props into the
// hibernatable Durable Object bridge.
// ---------------------------------------------------------------------------

let handlerPromise: Promise<{
  readonly app: (request: Request) => Promise<Response>;
  readonly mcp: (request: Request, env: CloudflareEnv, ctx: ExecutionContext) => Promise<Response>;
}> | null = null;

const resolveHandler = (env: CloudflareEnv) => {
  if (!handlerPromise) {
    handlerPromise = makeCloudflareApp(env).then(({ toWebHandler, mcpAgentHandler }) => ({
      app: toWebHandler().handler,
      mcp: mcpAgentHandler,
    }));
  }
  return handlerPromise;
};

const accessConfigErrorResponse = (missingVars: readonly string[]): Response =>
  new Response(`${cloudflareAccessConfigErrorMessage(missingVars)}\n`, {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });

const DEFAULT_ERXES_INTEGRATION = "erxes-officenext";

const executorRequest = (
  original: Request,
  path: string,
  method: string,
  body?: unknown,
): Request => {
  const url = new URL(original.url);
  url.pathname = path;
  url.search = "";
  const headers = new Headers();
  const authorization = original.headers.get("Authorization");
  if (authorization) headers.set("Authorization", authorization);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

const parseIntegrationSlug = (raw: unknown): string | null => {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_ERXES_INTEGRATION;
  if (typeof raw !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(raw)) return null;
  return raw;
};

const provisionErxes = async (
  request: Request,
  app: (request: Request) => Promise<Response>,
): Promise<Response> => {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let input: { endpoint?: unknown; cookie?: unknown; integration?: unknown };
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: malformed external JSON becomes a 400 response
  try {
    input = (await request.json()) as {
      endpoint?: unknown;
      cookie?: unknown;
      integration?: unknown;
    };
  } catch {
    return new Response("Invalid request", { status: 400 });
  }
  const integration = parseIntegrationSlug(input.integration);
  if (integration === null) return new Response("Invalid request", { status: 400 });
  if (
    typeof input.endpoint !== "string" ||
    typeof input.cookie !== "string" ||
    !input.cookie.startsWith("auth-token=") ||
    input.cookie.includes("\r") ||
    input.cookie.includes("\n")
  ) {
    return new Response("Invalid request", { status: 400 });
  }

  const existing = await app(
    executorRequest(request, `/api/graphql/integrations/${integration}`, "GET"),
  );
  if (!existing.ok) return existing;
  if ((await existing.json()) === null) {
    const created = await app(
      executorRequest(request, "/api/graphql/integrations", "POST", {
        endpoint: input.endpoint,
        slug: integration,
        name: integration,
        description: `${integration} Erxes GraphQL API`,
        authenticationTemplate: [
          {
            slug: "cookie",
            type: "apiKey",
            headers: { Cookie: [{ type: "variable", name: "token" }] },
          },
        ],
      }),
    );
    if (!created.ok && created.status !== 409) return created;
  }

  return app(
    executorRequest(request, "/api/connections", "POST", {
      owner: "user",
      name: integration,
      integration,
      template: "cookie",
      value: input.cookie,
      identityLabel: integration,
      description: `Your ${integration} account`,
    }),
  );
};

export default {
  fetch: async (request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> => {
    const missingAccessVars = missingCloudflareAccessVars(env);
    if (missingAccessVars.length > 0) {
      return accessConfigErrorResponse(missingAccessVars);
    }

    const serve = await resolveHandler(env);
    const url = new URL(request.url);
    if (url.pathname === "/os/mcp") {
      url.pathname = "/mcp";
      return serve.mcp(new Request(url, request), env, ctx);
    }
    if (url.pathname === "/os/provision") {
      return provisionErxes(request, serve.app);
    }
    if (url.pathname === "/mcp") {
      return serve.mcp(request, env, ctx);
    }
    return serve.app(request);
  },
};
