"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ShieldCheck, UserPlus, Users } from "lucide-react";
import { useOrganization } from "@/components/org-shell";
import { graphql } from "@/lib/graphql";
import { demoMode } from "@/lib/nhost";

interface Member { id: string; role: string; user: { id: string; displayName: string; email?: string; avatarUrl?: string } }
export default function MembersPage() {
  const { orgId } = useParams<{ orgId: string }>(); const { role } = useOrganization();
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => { if (demoMode) { setMembers([{ id: "1", role: "owner", user: { id: "1", displayName: "Avery Morgan", email: "owner@northstar.demo" } }, { id: "2", role: "editor", user: { id: "2", displayName: "Sam Rivera", email: "editor@northstar.demo" } }, { id: "3", role: "viewer", user: { id: "3", displayName: "Jordan Lee", email: "viewer@northstar.demo" } }]); return; } graphql<{ org_members: Member[] }>(`query Members($orgId: uuid!) { org_members(where: {organization_id: {_eq: $orgId}}, order_by: {created_at: asc}) { id role user { id displayName email avatarUrl } } }`, { orgId }).then((data) => setMembers(data.org_members)); }, [orgId]);
  return <div className="content-page"><header className="page-header"><div><span className="page-kicker">ACCESS CONTROL</span><h1>Members</h1><p>Organization roles drive both data access and workflow actions.</p></div>{role === "owner" && <button className="button button-primary"><UserPlus />Invite member</button>}</header><section className="simple-panel"><div className="section-title"><div><span className="metric-icon small teal"><Users /></span><div><h2>Organization members</h2><p>{members.length} people</p></div></div></div><div className="member-list">{members.map((member) => <article key={member.id}><span className="member-avatar">{member.user.displayName.slice(0, 1)}</span><div><strong>{member.user.displayName}</strong><p>{member.user.email}</p></div><span className={`role-pill ${member.role}`}><ShieldCheck />{member.role}</span></article>)}</div></section></div>;
}
