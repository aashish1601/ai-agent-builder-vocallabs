import { createClient } from "@nhost/nhost-js";

const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN;
const region = process.env.NEXT_PUBLIC_NHOST_REGION;

export const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true" || !subdomain;

export const nhost = createClient({
  subdomain: subdomain ?? "local",
  region: region ?? "local",
  graphqlUrl: process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL,
  authUrl: process.env.NEXT_PUBLIC_NHOST_AUTH_URL,
  functionsUrl: process.env.NEXT_PUBLIC_NHOST_FUNCTIONS_URL,
});

export const graphqlUrl =
  process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL ??
  (subdomain && region
    ? `https://${subdomain}.graphql.${region}.nhost.run/v1`
    : "https://local.graphql.local.nhost.run/v1");
