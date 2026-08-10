"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Activity, Blocks, ChevronDown, Gauge, HelpCircle, LogOut, Menu, Settings, Sparkles, Users, X } from "lucide-react";
import { ProtectedPage } from "./protected-page";
import { useAuth } from "./auth-provider";
import { graphql } from "@/lib/graphql";
import { demoMode } from "@/lib/nhost";
import { demoOrganization } from "@/lib/demo-data";

type Role = "owner" | "editor" | "viewer";
interface OrgValue { organization: typeof demoOrganization; role: Role; loading: boolean }
const OrgContext = createContext<OrgValue | null>(null);

export function useOrganization() {
  const value = useContext(OrgContext);
  if (!value) throw new Error("useOrganization must be used in OrgShell");
  return value;
}

export function OrgShell({ organizationId, children }: { organizationId: string; children: React.ReactNode }) {
  return <ProtectedPage><OrgShellInner organizationId={organizationId}>{children}</OrgShellInner></ProtectedPage>;
}

function OrgShellInner({ organizationId, children }: { organizationId: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { session, signOut, isDemo } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [value, setValue] = useState<OrgValue>({ organization: demoOrganization, role: "owner", loading: true });

  useEffect(() => {
    if (demoMode) { setValue({ organization: demoOrganization, role: "owner", loading: false }); return; }
    graphql<{ org_members: Array<{ role: Role; organization: typeof demoOrganization }> }>(`query OrganizationContext($id: uuid!) {
      org_members(where: {organization_id: {_eq: $id}}, limit: 1) {
        role
        organization { id name slug quota_allowed quota_used quota_reserved }
      }
    }`, { id: organizationId }).then(({ org_members }) => {
      if (!org_members[0]) router.replace("/workspace");
      else setValue({ ...org_members[0], loading: false });
    });
  }, [organizationId, router]);

  const quotaPercentage = Math.min(100, Math.round((value.organization.quota_used / value.organization.quota_allowed) * 100));
  const nav = useMemo(() => [
    { label: "Workflows", href: `/org/${organizationId}/workflows`, icon: Blocks },
    { label: "Run activity", href: `/org/${organizationId}/activity`, icon: Activity },
    { label: "Members", href: `/org/${organizationId}/members`, icon: Users },
    { label: "Settings", href: `/org/${organizationId}/settings`, icon: Settings },
  ], [organizationId]);

  return (
    <OrgContext.Provider value={value}>
      <div className="app-shell">
        <button className="mobile-menu" onClick={() => setMobileOpen(true)}><Menu /></button>
        <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>
          <div className="sidebar-head"><Link href="/workspace" className="brand brand-light"><span className="brand-mark"><Sparkles size={17} /></span>AgentForge</Link><button onClick={() => setMobileOpen(false)} className="sidebar-close"><X /></button></div>
          <button className="org-switcher"><span>{value.organization.name.slice(0, 1)}</span><div><strong>{value.organization.name}</strong><small>{value.role} workspace</small></div><ChevronDown /></button>
          <nav className="sidebar-nav">
            <small>WORKSPACE</small>
            {nav.map((item) => <Link className={pathname.startsWith(item.href) ? "active" : ""} href={item.href} key={item.label}><item.icon />{item.label}</Link>)}
          </nav>
          <div className="quota-card">
            <div><Gauge /><span><strong>Monthly usage</strong><small>{value.organization.quota_used} / {value.organization.quota_allowed} runs</small></span></div>
            <div className="quota-track"><i style={{ width: `${quotaPercentage}%` }} /></div>
            <p>{value.organization.quota_allowed - value.organization.quota_used} runs remaining</p>
          </div>
          <div className="sidebar-bottom">
            <a href="https://docs.nhost.io" target="_blank"><HelpCircle />Documentation</a>
            <button onClick={async () => { await signOut(); router.push("/sign-in"); }}><LogOut />Sign out</button>
            <div className="user-chip"><span>{session?.user?.displayName?.slice(0, 1) ?? "U"}</span><div><strong>{session?.user?.displayName || "Workspace user"}</strong><small>{isDemo ? "Demo owner" : session?.user?.email}</small></div></div>
          </div>
        </aside>
        <main className="app-main">{children}</main>
      </div>
    </OrgContext.Provider>
  );
}
