import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("security configuration", () => {
  it("contains valid YAML in every concrete metadata document", () => {
    const tablesDirectory = resolve(root, "nhost/metadata/databases/default/tables");
    const metadataFiles = readdirSync(tablesDirectory)
      .filter((file) => file.endsWith(".yaml") && file !== "tables.yaml")
      .map((file) => resolve(tablesDirectory, file))
      .concat([
        resolve(root, "nhost/metadata/actions.yaml"),
        resolve(root, "nhost/metadata/cron_triggers.yaml"),
      ]);

    for (const file of metadataFiles) {
      const document = parseDocument(readFileSync(file, "utf8"));
      expect(document.errors, file).toHaveLength(0);
    }
  });

  it("scopes workflow, run, and step reads through membership", () => {
    for (const file of ["public_workflows.yaml", "public_workflow_runs.yaml", "public_step_runs.yaml"]) {
      const metadata = read(`nhost/metadata/databases/default/tables/${file}`);
      expect(metadata).toContain("X-Hasura-User-Id");
      expect(metadata).toContain("members:");
    }
  });

  it("uses the current Nhost Auth database column names", () => {
    const users = read("nhost/metadata/databases/default/tables/auth_users.yaml");
    expect(users).toContain("columns: [id, display_name, avatar_url, email]");
    expect(users).toContain("display_name: { custom_name: displayName }");
    expect(users).toContain("select: users");
    expect(users).toContain("name: roles");
    expect(users).toContain("name: userProviders");
    expect(read("nhost/metadata/databases/default/tables/auth_roles.yaml")).toContain("select: authRoles");
  });

  it("makes dangerous nodes and webhook triggers owner-only", () => {
    const steps = read("nhost/metadata/databases/default/tables/public_workflow_steps.yaml");
    const triggers = read("nhost/metadata/databases/default/tables/public_workflow_triggers.yaml");
    expect(steps).toContain("_nin: [db_write, notify]");
    expect(steps).toContain("_eq: owner");
    expect(triggers).toContain("_neq: webhook");
    expect(triggers).toContain("_eq: owner");
  });

  it("keeps action endpoints behind Hasura's webhook secret", () => {
    const actions = read("nhost/metadata/actions.yaml");
    expect(actions.match(/value_from_env: NHOST_WEBHOOK_SECRET/g)?.length).toBeGreaterThanOrEqual(1);
    for (const handler of ["save-workflow.ts", "trigger-workflow-run.ts", "approve-step.ts", "trigger-workflow-webhook.ts"]) {
      expect(read(`functions/actions/${handler}`)).toContain("verifyInternalWebhook(req)");
    }
  });

  it("keeps cloud database access deploy-safe and avoids resetting current-month quota", () => {
    expect(read("nhost/nhost.toml")).toContain("enablePublicAccess = true");
    const service = read("functions/_lib/workflow-service.ts");
    expect(service).toContain("date_trunc('month', organization.quota_period_start)");
    expect(service).toContain("THEN organization.quota_used + organization.quota_reserved");
  });

  it("creates a run snapshot with one atomic database statement", () => {
    const service = read("functions/_lib/workflow-service.ts");
    expect(service).toContain("WITH request AS MATERIALIZED");
    expect(service).toContain("inserted_steps AS");
    expect(service).toContain("inserted_job AS");
    expect(service).not.toContain("for (const step of steps.rows)");
  });

  it("preserves webhook secrets when a newly added trigger has no client-side id", () => {
    const service = read("functions/_lib/workflow-service.ts");
    expect(service).toContain("oldTriggerByType");
    expect(service).toContain("?? oldTriggerByType.get(trigger.type)");
  });
});
