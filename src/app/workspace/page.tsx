"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Building2, LogOut, Plus, Sparkles } from "lucide-react";
import { ProtectedPage } from "@/components/protected-page";
import { useAuth } from "@/components/auth-provider";
import { graphql } from "@/lib/graphql";
import { demoMode } from "@/lib/nhost";
import { demoOrganization } from "@/lib/demo-data";

interface Membership {
  role: "owner" | "editor" | "viewer";
  organization: typeof demoOrganization;
}

export default function WorkspacePage() {
  return <ProtectedPage><WorkspaceChooser /></ProtectedPage>;
}

function WorkspaceChooser() {
  const router = useRouter();
  const { session, signOut } = useAuth();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (demoMode) {
      setMemberships([{ role: "owner", organization: demoOrganization }]);
      setLoading(false);
      return;
    }
    const userId = session?.user?.id;
    if (!userId) return;
    graphql<{ org_members: Membership[] }>(`query MyOrganizations($userId: uuid!) {
      org_members(where: {user_id: {_eq: $userId}}, order_by: {created_at: asc}) {
        role
        organization { id name slug quota_allowed quota_used quota_reserved }
      }
    }`, { userId }).then((data) => {
      setMemberships(data.org_members);
      if (data.org_members.length === 1) router.replace(`/org/${data.org_members[0].organization.id}/workflows`);
    }).finally(() => setLoading(false));
  }, [router, session?.user?.id]);

  return (
    <main className="workspace-picker">
      <header><Link href="/" className="brand brand-dark"><span className="brand-mark"><Sparkles size={18} /></span>AgentForge</Link><button className="text-button" onClick={async () => { await signOut(); router.push("/sign-in"); }}><LogOut size={16} /> Sign out</button></header>
      <section>
        <span className="form-kicker">YOUR WORKSPACES</span>
        <h1>Where are you working today?</h1>
        <p>Permissions and workflow data stay isolated inside each organization.</p>
        <div className="workspace-grid">
          {loading ? <div className="workspace-card loading-card" /> : memberships.map(({ role, organization }) => (
            <Link className="workspace-card" key={organization.id} href={`/org/${organization.id}/workflows`}>
              <span className="workspace-icon"><Building2 /></span>
              <div><h2>{organization.name}</h2><p>{role} · {organization.quota_used} of {organization.quota_allowed} runs used</p></div>
              <ArrowRight />
            </Link>
          ))}
          <button className="workspace-card workspace-add" disabled><span className="workspace-icon"><Plus /></span><div><h2>New organization</h2><p>Provisioned by an administrator</p></div></button>
        </div>
        <p className="signed-in-as">Signed in as {session?.user?.email}</p>
      </section>
    </main>
  );
}
