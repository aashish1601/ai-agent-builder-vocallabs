import { nhost } from "./nhost";

export class GraphQLRequestError extends Error {
  constructor(message: string, readonly errors: unknown[] = []) {
    super(message);
  }
}

export async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await nhost.graphql.request<T>({ query, variables });
  const body = response.body as { data?: T; errors?: Array<{ message?: string }> };
  if (body.errors?.length) {
    throw new GraphQLRequestError(body.errors[0]?.message ?? "GraphQL request failed", body.errors);
  }
  if (!body.data) throw new GraphQLRequestError("GraphQL response did not include data");
  return body.data;
}
