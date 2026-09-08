// Ephemeral LXC dashboard — vanilla JS, talks to /api/*.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function api(path, opts) {
  const res = await fetch(`/api${path}`, {
    headers: opts?.body ? { "content-type": "application/json" } : undefined,
    ...opts,
  });
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return "—";
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}

function badge(status) {
  return `<span class="badge ${esc(status)}">${esc(status)}</span>`;
}

function vmRows(list, { history } = {}) {
  if (!list.length) return `<div class="empty">Nothing here.</div>`;
  const extra = history ? "<th>Created</th><th>Destroyed</th>" : "<th>Age</th>";
  return `<table><thead><tr>
      <th>Name</th><th>VMID</th><th>IP</th><th>Status</th><th>Task</th>${extra}<th>Tags</th>
    </tr></thead><tbody>
    ${list.map((v) => `<tr data-vmid="${v.vmid}" data-id="${v.id}">
      <td>${esc(v.name)}</td>
      <td class="mono">${v.vmid}</td>
      <td class="mono">${esc(v.ip || "—")}</td>
      <td>${badge(v.status)}</td>
      <td>${esc(v.task_description || "")}</td>
      ${history
        ? `<td class="mono">${esc(v.created_at || "")}</td><td class="mono">${esc(v.destroyed_at || "—")}</td>`
        : `<td>${fmtDuration(v.age_seconds)}</td>`}
      <td class="tags">${esc(v.tags || "")}</td>
    </tr>`).join("")}
  </tbody></table>`;
}

// ---- Active ---------------------------------------------------------

async function renderActive() {
  const el = $("#tab-active");
  el.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const list = await api("/vms");
    el.innerHTML = vmRows(list);
    $$("tr[data-vmid]", el).forEach((tr) => (tr.onclick = () => openDrawer(+tr.dataset.vmid)));
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---- History -------------------------------------------------------

async function renderHistory() {
  const el = $("#tab-history");
  if (!el.dataset.init) {
    el.dataset.init = "1";
    el.innerHTML = `
      <div class="filters">
        <input id="h-name" placeholder="name contains…" />
        <input id="h-from" type="date" />
        <input id="h-to" type="date" />
        <button class="btn" id="h-go">Filter</button>
        <button class="btn" id="h-clear">Clear</button>
      </div>
      <div id="h-results"></div>`;
    $("#h-go", el).onclick = loadHistory;
    $("#h-clear", el).onclick = () => {
      $("#h-name").value = $("#h-from").value = $("#h-to").value = "";
      loadHistory();
    };
    ["h-name", "h-from", "h-to"].forEach((id) =>
      $(`#${id}`, el).addEventListener("keydown", (ev) => ev.key === "Enter" && loadHistory()));
  }
  loadHistory();
}

async function loadHistory() {
  const box = $("#h-results");
  box.innerHTML = `<p class="muted">Loading…</p>`;
  const q = new URLSearchParams();
  const name = $("#h-name").value.trim();
  const from = $("#h-from").value;
  const to = $("#h-to").value;
  if (name) q.set("name", name);
  if (from) q.set("from", from);
  if (to) q.set("to", `${to} 23:59:59`);
  try {
    const list = await api(`/history?${q}`);
    box.innerHTML = vmRows(list, { history: true });
    $$("tr[data-vmid]", box).forEach((tr) => (tr.onclick = () => openDrawer(+tr.dataset.vmid)));
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---- Drawer (detail + logs + actions) ------------------------------

let currentVmid = null;

function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#backdrop").classList.remove("open");
  currentVmid = null;
}

async function openDrawer(vmid) {
  currentVmid = vmid;
  $("#drawer").classList.add("open");
  $("#backdrop").classList.add("open");
  $("#drawer-title").textContent = `CT ${vmid}`;
  const body = $("#drawer-body");
  body.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const report = await api(`/vms/${vmid}`);
    body.innerHTML = detailHtml(report);
    wireActions(vmid);
  } catch (e) {
    // Still offer logs even if the live lookup failed (e.g. destroyed container).
    body.innerHTML = `<div class="drift">${esc(e.message)}</div><div id="logs"></div>`;
  }
  loadLogs(vmid);
}

function detailHtml(report) {
  const db = report.db || {};
  const px = report.proxmox || {};
  const drift = (report.drift || []).map((d) => `<div class="drift">⚠ ${esc(d)}</div>`).join("");
  const pxStatus = px.error ? `error: ${esc(px.error)}` : esc(px.status || "?");
  return `
    ${drift}
    <div class="kv">
      <div>Name</div><div>${esc(db.name || "")}</div>
      <div>DB status</div><div>${badge(db.status || "?")}</div>
      <div>Proxmox</div><div>${pxStatus}${px.uptime ? ` · up ${fmtDuration(px.uptime)}` : ""}</div>
      <div>IP</div><div class="mono">${esc(db.ip || "—")}</div>
      <div>Node</div><div>${esc(db.node || "")}</div>
      <div>Resources</div><div>${esc(db.cores)} vCPU · ${esc(db.memory_mb)} MiB · ${esc(db.clone_type)}</div>
      <div>Task</div><div>${esc(db.task_description || "")}</div>
      <div>Tags</div><div class="tags">${esc(db.tags || "")}</div>
      <div>Created</div><div class="mono">${esc(db.created_at || "")}</div>
      ${db.destroyed_at ? `<div>Destroyed</div><div class="mono">${esc(db.destroyed_at)}</div>` : ""}
      <div>post_create</div><div>${db.post_create_ran ? esc(db.post_create_ran) : "not run"}</div>
    </div>
    ${db.status !== "destroyed" ? `<div class="actions">
      <button class="btn" data-act="start">Start</button>
      <button class="btn" data-act="stop">Stop</button>
      <button class="btn" data-act="reboot">Reboot</button>
      <button class="btn danger" data-act="destroy">Destroy</button>
    </div>` : ""}
    <div id="logs"></div>`;
}

function wireActions(vmid) {
  $$("#drawer-body [data-act]").forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      if (act === "destroy" && !confirm(`Destroy CT ${vmid}? This permanently deletes the container.`)) return;
      $$("#drawer-body [data-act]").forEach((b) => (b.disabled = true));
      toast(`${act}…`);
      try {
        const r = await api(`/vms/${vmid}/${act}`, { method: "POST" });
        toast(`CT ${vmid}: ${r.status || r.action} ok`);
        await openDrawer(vmid);
        refreshCurrentTab();
      } catch (e) {
        toast(e.message);
        $$("#drawer-body [data-act]").forEach((b) => (b.disabled = false));
      }
    };
  });
}

async function loadLogs(vmid) {
  const host = $("#logs");
  if (!host) return;
  host.innerHTML = `<p class="muted">Loading logs…</p>`;
  try {
    const data = await api(`/vms/${vmid}/logs`);
    const phases = data.phases || [];
    host.innerHTML = `
      <div class="logctl">
        <strong>Logs</strong>
        <select id="log-phase">
          <option value="">all phases</option>
          ${phases.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("")}
        </select>
        <button class="btn" id="log-reload">Reload</button>
      </div>
      <div id="log-list"></div>`;
    const render = (logs) => {
      $("#log-list").innerHTML = logs.length
        ? logs.map((l) => `<details class="logentry">
            <summary><span class="badge">${esc(l.phase)}</span><span class="mono muted">${esc(l.created_at)}</span></summary>
            <pre>${esc(l.output || "")}</pre>
          </details>`).join("")
        : `<div class="empty">No log entries.</div>`;
    };
    render(data.logs || []);
    const reload = async () => {
      const phase = $("#log-phase").value;
      const d = await api(`/vms/${vmid}/logs${phase ? `?phase=${encodeURIComponent(phase)}` : ""}`);
      render(d.logs || []);
    };
    $("#log-phase").onchange = reload;
    $("#log-reload").onclick = reload;
  } catch (e) {
    host.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---- Scripts ------------------------------------------------------

async function renderScripts() {
  const el = $("#tab-scripts");
  el.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const scripts = await api("/scripts");
    el.innerHTML = `
      <div class="script-list" id="script-list">
        ${scripts.map((s) => `<button data-name="${esc(s.name)}">${esc(s.name)} <span class="muted">(${s.script.length}b)</span></button>`).join("")}
        <button data-name="" id="new-script">+ New</button>
      </div>
      <div class="row"><input id="script-name" placeholder="script name" /></div>
      <textarea id="script-body" placeholder="#!/bin/bash&#10;set -euo pipefail&#10;"></textarea>
      <div class="row">
        <button class="btn primary" id="script-save">Save</button>
        <span class="muted" id="script-meta"></span>
      </div>`;
    const pick = async (name) => {
      $$("#script-list button").forEach((b) => b.classList.toggle("active", b.dataset.name === name));
      $("#script-name").value = name;
      $("#script-name").disabled = !!name;
      if (name) {
        const s = await api(`/scripts/${encodeURIComponent(name)}`);
        $("#script-body").value = s.script;
        $("#script-meta").textContent = `updated ${s.updated_at}`;
      } else {
        $("#script-body").value = "";
        $("#script-meta").textContent = "new script";
      }
    };
    $$("#script-list button").forEach((b) => (b.onclick = () => pick(b.dataset.name)));
    $("#script-save").onclick = async () => {
      const name = $("#script-name").value.trim();
      const script = $("#script-body").value;
      if (!name || !script) return toast("name and body required");
      try {
        await api(`/scripts/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ script }) });
        toast(`saved '${name}'`);
        renderScripts();
      } catch (e) {
        toast(e.message);
      }
    };
    if (scripts.length) pick(scripts[0].name);
    else pick("");
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---- Tabs / wiring ----------------------------------------------

const TABS = { active: renderActive, history: renderHistory, scripts: renderScripts };
let activeTab = "active";

function switchTab(tab) {
  activeTab = tab;
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  ["active", "history", "scripts"].forEach((t) => ($(`#tab-${t}`).hidden = t !== tab));
  TABS[tab]();
}

function refreshCurrentTab() {
  TABS[activeTab]();
}

$$("nav button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
$("#refresh").onclick = refreshCurrentTab;
$("#drawer-close").onclick = closeDrawer;
$("#backdrop").onclick = closeDrawer;
document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());
$("#logout").onclick = async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.href = "/login.html";
};

switchTab("active");
