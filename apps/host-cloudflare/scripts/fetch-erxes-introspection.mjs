#!/usr/bin/env node
// Fetch the OfficeNext GraphQL introspection snapshot for offline tool production.
// Writes apps/host-cloudflare/assets/erxes-introspection.json (wrapper: { data: ... }).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = process.env.ERXES_GRAPHQL_URL ?? "https://officenext.erxes.io/gateway/graphql";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../assets/erxes-introspection.json");

const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind
        name
        description
        fields(includeDeprecated: false) {
          name
          description
          args {
            name
            description
            type { ...TypeRef }
            defaultValue
          }
          type { ...TypeRef }
        }
        inputFields {
          name
          description
          type { ...TypeRef }
          defaultValue
        }
        interfaces { ...TypeRef }
        enumValues(includeDeprecated: false) {
          name
          description
        }
        possibleTypes { ...TypeRef }
      }
    }
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`;

const response = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query: INTROSPECTION_QUERY }),
});
if (!response.ok) {
  console.error(`Introspection failed: HTTP ${response.status}`);
  process.exit(1);
}
const payload = await response.json();
if (payload.errors?.length) {
  console.error("Introspection errors:", payload.errors);
  process.exit(1);
}
if (!payload.data?.__schema) {
  console.error("Introspection response missing schema");
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload));
console.log(`Wrote ${OUT} (${(JSON.stringify(payload).length / 1_048_576).toFixed(2)} MiB)`);
