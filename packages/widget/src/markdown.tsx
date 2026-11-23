import { h, type ComponentChildren } from "preact";

/**
 * Minimal, XSS-safe Markdown renderer producing virtual DOM nodes (never innerHTML).
 * Supports paragraphs, bullet/numbered lists, **bold**, *italic*, `code`, [links](url) and bare URLs.
 * Links are clickable only for approved hosts; others render as plain text.
 */
export function renderMarkdown(text: string, approvedHosts: string[], onLink?: (url: string) => void): ComponentChildren {
  const blocks: ComponentChildren[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => { if (para.length) { blocks.push(<p>{inline(para.join(" "), approvedHosts, onLink)}</p>); para = []; } };
  const flushList = () => {
    if (list) {
      const items = list.items.map((it) => <li>{inline(it, approvedHosts, onLink)}</li>);
      blocks.push(list.ordered ? <ol>{items}</ol> : <ul>{items}</ul>);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const num = line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || num) {
      flushPara();
      const ordered = !!num;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push((bullet ?? num)![1]);
    } else if (!line) { flushPara(); flushList(); }
    else {
      flushList();
      para.push(line.replace(/^#{1,6}\s+/, ""));
    }
  }
  flushPara(); flushList();
  return blocks;
}

function hostAllowed(url: string, hosts: string[]): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "mailto:" || u.protocol === "tel:") return true;
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return hosts.some((hh) => u.hostname === hh || u.hostname.endsWith("." + hh));
  } catch { return false; }
}

const TOKEN = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|[\w.+-]+@[\w-]+\.[\w.-]+\w)/g;

function inline(text: string, hosts: string[], onLink?: (url: string) => void): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code>{t.slice(1, -1)}</code>);
    else if (t.startsWith("[")) {
      const mm = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      out.push(link(mm[1], mm[2], hosts, onLink));
    } else if (t.startsWith("http")) out.push(link(t.replace(/^https?:\/\//, "").replace(/\/$/, ""), t, hosts, onLink));
    else if (t.includes("@") && !t.startsWith("*")) out.push(link(t, "mailto:" + t, hosts, onLink));
    else out.push(<em>{t.slice(1, -1)}</em>);
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function link(label: string, url: string, hosts: string[], onLink?: (url: string) => void) {
  if (!hostAllowed(url, hosts)) return h("span", null, label);
  const external = url.startsWith("http");
  return <a href={url} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} onClick={() => onLink?.(url)}>{label}</a>;
}
