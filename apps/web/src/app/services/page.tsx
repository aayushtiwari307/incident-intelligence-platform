"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ServiceDto } from "@platform/shared";
import { AppShell, useCan } from "../../components/shell";
import { Field, FormError } from "../../components/ui";
import { errorText, relativeTime } from "../../lib/format";
import { api } from "../../lib/session";

export default function ServicesPage() {
  return <AppShell><Services /></AppShell>;
}

function Services() {
  const canManage = useCan("integration:manage");
  const [items, setItems] = useState<ServiceDto[]>([]);
  const [editing, setEditing] = useState<ServiceDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems(await api.listServices()); }
    catch (e) { setError(errorText(e)); }
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
      <h1>Service catalog</h1>
      <p className="muted">Services scope incident ownership and deployment/change context to this organization. Alertmanager alerts with a matching <code>service</code> label are linked automatically.</p>
      <FormError message={error} />
      {notice ? <p role="status" className="notice">{notice}</p> : null}

      {canManage ? (
        <section aria-labelledby="create-service-h">
          <h2 id="create-service-h">Add a service</h2>
          <form className="card inline" onSubmit={create} aria-label="Create service">
            <Field label="Service name" htmlFor="service-name"><input id="service-name" name="name" required maxLength={100} /></Field>
            <Field label="Owner team" htmlFor="service-owner"><input id="service-owner" name="ownerTeam" required maxLength={80} /></Field>
            <Field label="Tier" htmlFor="service-tier"><select id="service-tier" name="tier" defaultValue="tier3"><option value="tier1">Tier 1</option><option value="tier2">Tier 2</option><option value="tier3">Tier 3</option></select></Field>
            <button type="submit" className="btn">Create service</button>
          </form>
        </section>
      ) : null}

      {editing && canManage ? (
        <section aria-labelledby="edit-service-h">
          <h2 id="edit-service-h">Edit {editing.name}</h2>
          <form className="card inline" onSubmit={update}>
            <Field label="Service name" htmlFor="edit-service-name"><input id="edit-service-name" name="name" defaultValue={editing.name} required maxLength={100} /></Field>
            <Field label="Owner team" htmlFor="edit-service-owner"><input id="edit-service-owner" name="ownerTeam" defaultValue={editing.ownerTeam} required maxLength={80} /></Field>
            <Field label="Tier" htmlFor="edit-service-tier"><select id="edit-service-tier" name="tier" defaultValue={editing.tier}><option value="tier1">Tier 1</option><option value="tier2">Tier 2</option><option value="tier3">Tier 3</option></select></Field>
            <button type="submit" className="btn">Save changes</button>
            <button type="button" className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
          </form>
        </section>
      ) : null}

      <section aria-labelledby="services-list-h">
        <h2 id="services-list-h">Organization services</h2>
        {items.length === 0 ? <p className="muted">No services configured yet.</p> : (
          <table className="table">
            <caption className="visually-hidden">Organization service catalog</caption>
            <thead><tr><th scope="col">Service</th><th scope="col">Owner team</th><th scope="col">Tier</th><th scope="col">Updated</th>{canManage ? <th scope="col">Actions</th> : null}</tr></thead>
            <tbody>{items.map((service) => <tr key={service.id}>
              <td>{service.name}</td><td>{service.ownerTeam}</td><td>{service.tier.toUpperCase()}</td><td>{relativeTime(service.updatedAt)}</td>
              {canManage ? <td><button type="button" className="btn-link" onClick={() => setEditing(service)}>Edit</button>{" "}<button type="button" className="btn-link danger" onClick={() => void remove(service)}>Delete</button></td> : null}
            </tr>)}</tbody>
          </table>
        )}
      </section>
    </>
  );
}
