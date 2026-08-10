"use client";

import { Building2, Gauge, KeyRound, Save } from "lucide-react";
import { useOrganization } from "@/components/org-shell";

export default function SettingsPage() {
  const { organization, role } = useOrganization();
  return <div className="content-page"><header className="page-header"><div><span className="page-kicker">ORGANIZATION</span><h1>Settings</h1><p>Workspace identity, quota and security configuration.</p></div></header><div className="settings-grid"><section className="simple-panel settings-card"><div className="section-title"><div><span className="metric-icon small blue"><Building2 /></span><div><h2>Workspace details</h2><p>Visible to organization members.</p></div></div></div><label>Organization name<input disabled={role !== "owner"} defaultValue={organization.name} /></label><label>Workspace slug<input disabled={role !== "owner"} defaultValue={organization.slug} /></label>{role === "owner" && <button className="button button-primary button-small"><Save />Save changes</button>}</section><section className="simple-panel settings-card"><div className="section-title"><div><span className="metric-icon small amber"><Gauge /></span><div><h2>Usage quota</h2><p>Concurrent starts reserve capacity atomically.</p></div></div></div><div className="quota-large"><strong>{organization.quota_used}</strong><span>of {organization.quota_allowed} workflow runs used</span><div className="quota-track"><i style={{ width: `${(organization.quota_used / organization.quota_allowed) * 100}%` }} /></div></div><div className="permission-note"><KeyRound /><div><strong>Protected server-side</strong><p>Clients cannot edit quota counters. Functions update them inside locked PostgreSQL transactions.</p></div></div></section></div></div>;
}
