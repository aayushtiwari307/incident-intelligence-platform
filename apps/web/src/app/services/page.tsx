"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ServiceDto } from "@platform/shared";
import { Icon } from "../../components/icons";
import { AppShell, useCan } from "../../components/shell";
import { EmptyState, FormError, PageHeader, SkeletonRows } from "../../components/ui";
import { errorText, relativeTime } from "../../lib/format";
import { api } from "../../lib/session";

export default function ServicesPage() {
  return <AppShell><Services /></AppShell>;
}

const TIER_OPTIONS = [
  { value: "tier3", label: "Tier 3" },
  { value: "tier2", label: "Tier 2" },
  { value: "tier1", label: "Tier 1" },
] as const;

function Services() {
  const canManage = useCan("integration:manage");
  const [items, setItems] = useState<ServiceDto[] | null>(null);
  const [editing, setEditing] = useState<ServiceDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems(await api.listServices()); }
    catch (e) { setError(errorText(e)); setItems((prev) => prev ?? []); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError(null); setNotice(null);
    try {
      await api.createService({ name: String(data.get("name")).trim(), ownerTeam: String(data.get("ownerTeam")).trim(), tier: String(data.get("tier")) as ServiceDto["tier"] });
      form.reset(); setNotice("Service created."); await load();
    } catch (e) { setError(errorText(e)); }
  }

  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const data = new FormData(event.currentTarget);
    setError(null); setNotice(null);
    try {
      await api.updateService(editing.id, { name: String(data.get("name")).trim(), ownerTeam: String(data.get("ownerTeam")).trim(), tier: String(data.get("tier")) as ServiceDto["tier"] });
      setEditing(null); setNotice("Service updated."); await load();
    } catch (e) { setError(errorText(e)); }
  }

  async function remove(service: ServiceDto) {
    if (!window.confirm(`Delete service “${service.name}”? Change history or linked incidents prevent deletion.`)) return;
    setError(null); setNotice(null);
    try { await api.removeService(service.id); setNotice("Service deleted."); await load(); }
    catch (e) { setError(errorText(e)); }
  }

  return (
    <>
      <PageHeader title="Services">
        Group incidents by what they run on. Alerts with a matching <code>service</code> label are linked automatically.
      </PageHeader>
      <div className="mt-lg" />
      <FormError message={error} />
      {notice ? <p role="status" className="notice ok">{notice}</p> : null}

      <div className="stack loose">
        {canManage ? (
          <section className="panel" aria-labelledby="create-service-h">
            <h2 id="create-service-h" className="label">Add a service</h2>
            <form className="form-grid" onSubmit={create} aria-label="Create service">
              <div className="field wide"><label htmlFor="service-name">Service name</label><input id="service-name" name="name" required maxLength={100} placeholder="payments-api" /></div>
              <div className="field"><label htmlFor="service-owner">Owner team</label><input id="service-owner" name="ownerTeam" required maxLength={80} placeholder="Platform Team" /></div>
              <div className="field" style={{ flex: "1 1 120px" }}><label htmlFor="service-tier">Tier</label><select id="service-tier" name="tier" defaultValue="tier3">{TIER_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
              <button type="submit" className="btn">Create service</button>
            </form>
          </section>
        ) : null}

        {editing && canManage ? (
          <section className="panel" aria-labelledby="edit-service-h">
            <h2 id="edit-service-h" className="label">Edit {editing.name}</h2>
            <form className="form-grid" onSubmit={update} aria-label="Edit service" key={editing.id}>
              <div className="field wide"><label htmlFor="edit-service-name">Service name</label><input id="edit-service-name" name="name" defaultValue={editing.name} required maxLength={100} /></div>
              <div className="field"><label htmlFor="edit-service-owner">Owner team</label><input id="edit-service-owner" name="ownerTeam" defaultValue={editing.ownerTeam} required maxLength={80} /></div>
              <div className="field" style={{ flex: "1 1 120px" }}><label htmlFor="edit-service-tier">Tier</label><select id="edit-service-tier" name="tier" defaultValue={editing.tier}>{TIER_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
              <div className="actions">
                <button type="submit" className="btn">Save changes</button>
                <button type="button" className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </form>
          </section>
        ) : null}

        <section aria-labelledby="services-list-h">
          <h2 id="services-list-h" className="visually-hidden">Organization services</h2>
          {items === null ? <div className="panel flush"><SkeletonRows rows={3} label="Loading services…" /></div> : null}
          {items && items.length === 0 ? (
            <div className="panel">
              <EmptyState center icon="services" title="No services yet">
                {canManage ? "Add your first service above. Incidents and deployment change events can then be linked to it." : "An owner or admin can add services. Once added, incidents and deployment change events can be linked to them."}
              </EmptyState>
            </div>
          ) : null}
          {items && items.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Organization service catalog</caption>
                <thead><tr><th scope="col">Service</th><th scope="col">Owner team</th><th scope="col">Tier</th><th scope="col">Updated</th>{canManage ? <th scope="col" className="num">Actions</th> : null}</tr></thead>
                <tbody>{items.map((service) => <tr key={service.id}>
                  <td><span className="ident"><span className="ident-icon"><Icon name="services" size={16} /></span><span style={{ overflowWrap: "anywhere" }}>{service.name}</span></span></td>
                  <td>{service.ownerTeam}</td>
                  <td><span className="chip plain">TIER {service.tier.replace("tier", "")}</span></td>
                  <td><span className="mono dim" style={{ fontSize: 12 }} title={service.updatedAt}>{relativeTime(service.updatedAt)}</span></td>
                  {canManage ? <td className="actions-cell"><button type="button" className="btn-link" onClick={() => setEditing(service)}>Edit</button><button type="button" className="btn-link danger" onClick={() => void remove(service)}>Delete</button></td> : null}
                </tr>)}</tbody>
              </table>
            </div>
          ) : null}
          {items && items.length > 0 ? <p className="list-foot">A service cannot be deleted while incidents or change events still reference it.</p> : null}
        </section>
      </div>
    </>
  );
}
