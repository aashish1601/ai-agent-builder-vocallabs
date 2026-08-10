import { OrgShell } from "@/components/org-shell";

export default async function OrganizationLayout({ children, params }: { children: React.ReactNode; params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return <OrgShell organizationId={orgId}>{children}</OrgShell>;
}
