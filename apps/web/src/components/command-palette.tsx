"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { IncidentDto } from "@platform/shared";
import { incidentRef } from "../lib/format";
import { api } from "../lib/session";
import { Icon, type IconName } from "./icons";

interface Item {
  id: string;
  group: "Go to" | "Incidents";
  label: string;
  ref?: string;
  href: string;
  icon: IconName;
  keywords: string;
}

const PAGES: Item[] = [
  { id: "page-incidents", group: "Go to", label: "Incidents", href: "/incidents", icon: "incidents", keywords: "incidents list home" },
  { id: "page-services", group: "Go to", label: "Services", href: "/services", icon: "services", keywords: "services catalog changes" },
  { id: "page-github", group: "Go to", label: "GitHub", href: "/github", icon: "github", keywords: "github issues pull requests repositories" },
  { id: "page-team", group: "Go to", label: "Team", href: "/team", icon: "team", keywords: "team members invitations integrations alertmanager ai" },
];

/**
 * Ctrl K "jump to" palette. It only navigates: pages, plus the most recent incidents the signed-in user can already read
 * (one ordinary list request, filtered in the browser). It never changes anything.
 */
export function CommandPalette({ onClose }: { onClose(): void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<IncidentDto[]>([]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.listIncidents({}).then(
      (page) => {
        if (!cancelled) setRecent(page.items);
      },
      () => undefined, // the palette still works for pages when the list cannot be loaded
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const items = useMemo<Item[]>(() => {
    const incidents: Item[] = recent.map((i) => ({
      id: `incident-${i.id}`,
      group: "Incidents",
      label: i.title,
      ref: incidentRef(i.number),
      href: `/incidents/${encodeURIComponent(i.id)}`,
      icon: "incidents",
      keywords: `${incidentRef(i.number)} ${i.number} ${i.title}`,
    }));
    const needle = query.trim().toLowerCase();
    const all = [...PAGES, ...incidents];
    if (!needle) return [...PAGES, ...incidents.slice(0, 6)];
    return all.filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(needle)).slice(0, 12);
  }, [query, recent]);

  useEffect(() => setActive(0), [query]);

  function go(item: Item | undefined) {
    if (!item) return;
    onClose();
    router.push(item.href);
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((value) => (items.length ? (value + 1) % items.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((value) => (items.length ? (value - 1 + items.length) % items.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(items[active]);
    } else if (event.key === "Tab") {
      event.preventDefault(); // keep focus in the field while the dialog is open
    }
  }

  let lastGroup = "";
  return (
    <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and jump to" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <Icon name="search" size={16} stroke={2} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Jump to a page or incident"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-options"
            aria-activedescendant={items[active] ? `palette-${items[active].id}` : undefined}
            aria-label="Search"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="kbd">Esc</span>
        </div>
        {items.length === 0 ? (
          <p className="palette-empty" role="status">
            Nothing matches “{query}”. Try an incident number like INC-0001 or part of a title.
          </p>
        ) : (
          <ul className="palette-list" id="palette-options" role="listbox" aria-label="Results">
            {items.map((item, index) => {
              const heading = item.group !== lastGroup ? item.group : null;
              lastGroup = item.group;
              return (
                <li key={item.id} role="presentation">
                  {heading ? <div className="palette-group">{heading}</div> : null}
                  <div
                    id={`palette-${item.id}`}
                    role="option"
                    aria-selected={index === active}
                    className="palette-item"
                    onMouseEnter={() => setActive(index)}
                    onClick={() => go(item)}
                  >
                    <Icon name={item.icon} size={15} />
                    {item.ref ? <span className="ref">{item.ref}</span> : null}
                    <span className="grow">{item.label}</span>
                    {index === active ? <Icon name="arrow" size={14} /> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="palette-foot">
          <span>↑ ↓ move</span>
          <span>Enter open</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  );
}
