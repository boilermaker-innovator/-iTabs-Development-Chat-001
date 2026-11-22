// iTabs Orders Worker
// Takes orders from iTabs cafe pages (POST /order) and shows them on a staff screen (/).
// Needs: D1 database bound as DB (table from schema.sql). Optional secret: STAFF_PIN.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const KEEP_MS = 1000 * 60 * 60 * 24 * 7;
const DONE_KEEP_MS = 1000 * 60 * 60 * 24; // finished orders drop off the screen after a day
const STATUSES = ["new", "making", "ready", "done"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (!env.DB) {
      return json({ error: "DB (D1) binding missing - add it in Worker settings" }, 500);
    }
    if (path === "/order" && request.method === "POST") {
      return receiveOrder(request, env);
    }
    if (path === "/" && request.method === "GET") {
      return new Response(STAFF_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    const pinOk = !env.STAFF_PIN || url.searchParams.get("pin") === env.STAFF_PIN;

    if (path === "/orders" && request.method === "GET") {
      if (!pinOk) return json({ error: "wrong pin" }, 401);
      return json(await listOrders(env));
    }

    const m = path.match(/^\/order\/([A-Za-z0-9-]+)\/status$/);
    if (m && request.method === "POST") {
      if (!pinOk) return json({ error: "wrong pin" }, 401);
      return setStatus(request, env, m[1]);
    }

    return json({ error: "not found" }, 404);
  },
};

async function receiveOrder(request, env) {
  const text = await request.text();
  if (text.length > 20000) return json({ error: "order too big" }, 413);

  let order;
  try { order = JSON.parse(text); } catch { return json({ error: "bad json" }, 400); }

  const problem = checkOrder(order);
  if (problem) return json({ error: problem }, 400);

  const now = Date.now();
  order.status = "new";
  order.received_at = new Date(now).toISOString();
  const sortKey = String(order.created_at || order.received_at);

  // Clear out expired orders, then insert. INSERT OR IGNORE keeps a resend of the
  // same order_id from overwriting the original (same as before: still replies "received").
  await env.DB.batch([
    env.DB.prepare("DELETE FROM orders WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO orders (order_id, status, sort_key, expires_at, data) VALUES (?, ?, ?, ?, ?)"
    ).bind(order.order_id, order.status, sortKey, now + KEEP_MS, JSON.stringify(order)),
  ]);
  return json({ status: "received", order_id: order.order_id });
}

function checkOrder(o) {
  if (!o || typeof o !== "object") return "no order";
  if (typeof o.order_id !== "string" || !/^[A-Za-z0-9-]{4,60}$/.test(o.order_id)) return "bad order_id";
  if (!o.customer || typeof o.customer.name !== "string" || !o.customer.name.trim()) return "missing customer name";
  if (!o.pickup || !["asap", "scheduled", "kerbside"].includes(o.pickup.type)) return "bad pickup type";
  if (!Array.isArray(o.items) || o.items.length === 0 || o.items.length > 50) return "no items";
  for (const it of o.items) {
    if (!it || typeof it.name !== "string") return "item missing name";
    if (!Number.isInteger(it.quantity) || it.quantity < 1) return "bad item quantity";
    if (typeof it.line_total_aud !== "number") return "bad item price";
  }
  if (typeof o.total_aud !== "number") return "bad total";
  return null;
}

async function listOrders(env) {
  const { results } = await env.DB.prepare(
    "SELECT data FROM orders WHERE expires_at > ? ORDER BY sort_key"
  ).bind(Date.now()).all();
  return results.map((r) => JSON.parse(r.data));
}

async function setStatus(request, env, id) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!body || !STATUSES.includes(body.status)) return json({ error: "bad status" }, 400);

  const now = Date.now();
  const updatedAt = new Date(now).toISOString();
  const expiresAt = now + (body.status === "done" ? DONE_KEEP_MS : KEEP_MS);
  const row = await env.DB.prepare(
    "UPDATE orders SET status = ?1, expires_at = ?2, " +
    "data = json_set(data, '$.status', ?1, '$.updated_at', ?3) " +
    "WHERE order_id = ?4 AND expires_at > ?5 RETURNING order_id"
  ).bind(body.status, expiresAt, updatedAt, id, now).first();
  if (!row) return json({ error: "order not found" }, 404);

  return json({ status: "updated", order_id: id, order_status: body.status });
}

const STAFF_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>iTabs Orders - Staff</title>
<style>
  body { margin:0; font-family: system-ui, -apple-system, sans-serif; background:#111; color:#eee; }
  header { padding:14px 16px; background:#1c1c1c; display:flex; justify-content:space-between; align-items:center; position:sticky; top:0; }
  h1 { font-size:20px; margin:0; }
  #note { font-size:13px; color:#999; }
  #list { padding:12px; display:grid; gap:12px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
  .card { background:#1e1e1e; border-radius:12px; padding:14px; border-left:6px solid #d4a017; }
  .card.making { border-color:#3b82f6; }
  .card.ready { border-color:#22c55e; }
  .card.done { opacity:.45; border-color:#555; }
  .top { display:flex; justify-content:space-between; font-weight:700; font-size:18px; }
  .meta { color:#aaa; font-size:14px; margin:4px 0 8px; }
  .item { font-size:16px; margin:4px 0; }
  .opts { color:#bbb; font-size:14px; }
  .btns { display:flex; gap:8px; margin-top:10px; }
  button { flex:1; padding:12px; font-size:16px; border:0; border-radius:8px; color:#fff; background:#333; }
  button:disabled { opacity:.5; }
  .b-making { background:#2563eb; } .b-ready { background:#16a34a; } .b-done { background:#555; }
  .empty { color:#888; padding:30px; text-align:center; }
</style>
</head>
<body>
<header><h1>iTabs Orders</h1><span id="note">loading...</span></header>
<div id="list"></div>
<script>
var pin = new URLSearchParams(location.search).get("pin") || "";
var q = pin ? "?pin=" + encodeURIComponent(pin) : "";
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c];
  });
}
function timeOf(t) {
  if (!t || t === "ASAP") return "ASAP";
  var d = new Date(t);
  return isNaN(d) ? esc(t) : d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone: "Australia/Perth" });
}
function render(orders) {
  var list = document.getElementById("list");
  if (!orders.length) { list.innerHTML = '<div class="empty">No orders yet</div>'; return; }
  var rank = { new:0, making:1, ready:2, done:3 };
  orders.sort(function (a, b) { return (rank[a.status] || 0) - (rank[b.status] || 0); });
  list.innerHTML = orders.map(function (o) {
    var items = (o.items || []).map(function (it) {
      var opts = [it.size, it.milk].concat(it.extras || []).filter(Boolean).join(", ");
      return '<div class="item">' + esc(it.quantity) + ' x ' + esc(it.name) +
        (opts ? ' <span class="opts">(' + esc(opts) + ')</span>' : '') + '</div>';
    }).join("");
    var kerb = o.kerbside ? '<div class="meta">Car: ' + esc([o.kerbside.car_colour, o.kerbside.car_make, o.kerbside.rego].filter(Boolean).join(" ")) + '</div>' : "";
    var pickup = o.pickup ? esc(o.pickup.type) + ' - ' + timeOf(o.pickup.time) : "";
    return '<div class="card ' + esc(o.status) + '">' +
      '<div class="top"><span>' + esc(o.customer && o.customer.name) + '</span><span>$' + Number(o.total_aud || 0).toFixed(2) + '</span></div>' +
      '<div class="meta">' + pickup + ' &middot; ' + esc(o.customer && o.customer.phone) + ' &middot; ' + esc(o.status) + '</div>' +
      kerb + items +
      '<div class="btns">' +
        '<button class="b-making" data-id="' + esc(o.order_id) + '" data-s="making">Making</button>' +
        '<button class="b-ready" data-id="' + esc(o.order_id) + '" data-s="ready">Ready</button>' +
        '<button class="b-done" data-id="' + esc(o.order_id) + '" data-s="done">Done</button>' +
      '</div></div>';
  }).join("");
}
function load() {
  fetch("/orders" + q).then(function (r) {
    if (r.status === 401) throw new Error("Wrong PIN - add ?pin=XXXX to the address");
    return r.json();
  }).then(function (orders) {
    render(orders);
    document.getElementById("note").textContent = "updated " + new Date().toLocaleTimeString("en-AU");
  }).catch(function (e) {
    document.getElementById("note").textContent = e.message;
  });
}
document.getElementById("list").addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b) return;
  b.disabled = true;
  fetch("/order/" + encodeURIComponent(b.dataset.id) + "/status" + q, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: b.dataset.s })
  }).then(function (r) {
    if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || "update failed"); });
  }).catch(function (err) {
    document.getElementById("note").textContent = "Could not update: " + err.message;
  }).then(load);
});
// Only poll while the screen is visible - each poll costs database reads.
load();
setInterval(function () { if (!document.hidden) load(); }, 5000);
document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
</script>
</body>
</html>`;
