// API de la fiesta de Halloween (Cloudflare Worker con archivos estáticos en /public)
// Listas abiertas: cualquiera puede añadir, editar o quitar. Todo queda en el historial.
//
// Necesita un binding D1 llamado DB.
// Opcional: variable ADMIN_KEY. Si existe, /admin, el historial, la descarga y «deshacer» piden esa clave.
// Opcional: variable EDIT_CODE. Si existe, para modificar hay que conocer ese código
// (una palabra que se comparte en el grupo de WhatsApp, para evitar spam de bots).

const LISTS = ['asistentes', 'choripan', 'paseo', 'disco', 'cena', 'limpieza', 'alergias'];
const QTY = ['normal', 'normal_sg', 'veg', 'veg_sg'];
const MAX_NAME = 160;
const MAX_QTY = 40;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const bad = (msg, status = 400, extra = {}) => json({ error: msg, ...extra }, status);

function cleanName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f⁠​]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}
function cleanQty(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_QTY);
}
const PRICES = { normal: 2, normal_sg: 3, veg: 3, veg_sg: 4 };
const paidKey = k => 'paid_' + k;
function rowOut(r) {
  return {
    id: r.id, list: r.list, name: r.name,
    normal: r.normal, normal_sg: r.normal_sg, veg: r.veg, veg_sg: r.veg_sg,
    paid_normal: r.paid_normal || 0, paid_normal_sg: r.paid_normal_sg || 0, paid_veg: r.paid_veg || 0, paid_veg_sg: r.paid_veg_sg || 0,
    locked: r.locked ? 1 : 0,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}
const hasPaid = r => QTY.some(k => (r[paidKey(k)] || 0) > 0);

// Crea las columnas/tablas nuevas si la base de datos es de una versión anterior
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const cols = (await env.DB.prepare('PRAGMA table_info(entries)').all()).results.map(c => c.name);
  const add = [...QTY.map(paidKey), 'locked'].filter(c => !cols.includes(c));
  for (const c of add) await env.DB.prepare(`ALTER TABLE entries ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`).run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)').run();
  schemaReady = true;
}
async function getSetting(env, key) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return r ? r.value : null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

function isAdmin(request, env, url) {
  if (!env.ADMIN_KEY) return true;
  const given = (request.headers.get('x-admin-key') || url.searchParams.get('key') || '').trim();
  return given === String(env.ADMIN_KEY).trim();
}

// Admin «de verdad»: solo cuando ADMIN_KEY está configurada y coincide
function isRealAdmin(request, env, url) {
  return !!env.ADMIN_KEY && isAdmin(request, env, url);
}

function checkCode(request, env) {
  if (!env.EDIT_CODE) return true;
  const given = (request.headers.get('x-edit-code') || '').trim().toLowerCase();
  return given === String(env.EDIT_CODE).trim().toLowerCase();
}

async function log(env, action, list, entryId, name, before, after) {
  await env.DB.prepare(
    'INSERT INTO log (action, list, entry_id, name, before, after) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(action, list, entryId, name, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null).run();
}

async function getEntry(env, id) {
  return env.DB.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first();
}

async function handleApi(request, env, url) {
  if (!env.DB) return bad('La base de datos no está conectada (falta el binding DB).', 500);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method.toUpperCase();
  await ensureSchema(env);

  // ---- Lectura ----
  if (method === 'GET' && path === '/api/data') {
    const { results } = await env.DB.prepare('SELECT * FROM entries ORDER BY list, id').all();
    const last = await env.DB.prepare('SELECT MAX(at) AS at FROM log').first();
    const choriLocked = (await getSetting(env, 'chori_locked')) === '1';
    return json({ entries: results.map(rowOut), updated_at: last?.at || null, needs_code: !!env.EDIT_CODE, chori_locked: choriLocked });
  }

  // ---- Zona admin (historial, descarga, deshacer) ----
  if (path === '/api/log' || path === '/api/export.csv' || /^\/api\/log\/\d+\/restore$/.test(path) || path === '/api/admin' || path.startsWith('/api/admin/')) {
    if (!isAdmin(request, env, url)) return bad('Clave de administración incorrecta.', 403, { need_admin: true });
  }
  if (method === 'GET' && path === '/api/admin') return json({ ok: true, has_key: !!env.ADMIN_KEY });

  // ---- Pagos y bloqueo de choripán (solo con ADMIN_KEY configurada) ----
  if (path.startsWith('/api/admin/')) {
    if (!env.ADMIN_KEY) return bad('Para bloquear pedidos y marcar pagos hay que configurar antes la clave ADMIN_KEY en Cloudflare.', 403);
    if (method !== 'POST') return bad('No encontrado.', 404);
    const b = (await readBody(request)) || {};
    if (path === '/api/admin/chori-lock') {
      const v = b.locked ? '1' : '0';
      await setSetting(env, 'chori_locked', v);
      await log(env, v === '1' ? 'lock_all' : 'unlock_all', 'choripan', null, v === '1' ? 'Pedidos de choripán cerrados' : 'Pedidos de choripán abiertos', null, null);
      return json({ ok: true, chori_locked: v === '1' });
    }
    const a = path.match(/^\/api\/admin\/entries\/(\d+)\/(pay|unpay|lock|unlock)$/);
    if (a) {
      const id = Number(a[1]), act = a[2];
      const before = await getEntry(env, id);
      if (!before || before.list !== 'choripan') return bad('Pedido no encontrado.', 404);
      let r;
      if (act === 'pay') {
        r = await env.DB.prepare("UPDATE entries SET paid_normal = normal, paid_normal_sg = normal_sg, paid_veg = veg, paid_veg_sg = veg_sg, updated_at = datetime('now') WHERE id = ? RETURNING *").bind(id).first();
      } else if (act === 'unpay') {
        r = await env.DB.prepare("UPDATE entries SET paid_normal = 0, paid_normal_sg = 0, paid_veg = 0, paid_veg_sg = 0, updated_at = datetime('now') WHERE id = ? RETURNING *").bind(id).first();
      } else {
        r = await env.DB.prepare("UPDATE entries SET locked = ?, updated_at = datetime('now') WHERE id = ? RETURNING *").bind(act === 'lock' ? 1 : 0, id).first();
      }
      await log(env, act, 'choripan', id, before.name, rowOut(before), rowOut(r));
      return json({ ok: true, entry: rowOut(r) });
    }
    return bad('No encontrado.', 404);
  }

  if (method === 'GET' && path === '/api/log') {
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '40', 10)));
    const { results } = await env.DB.prepare('SELECT * FROM log ORDER BY id DESC LIMIT ?').bind(limit).all();
    return json({ log: results.map(l => ({ ...l, before: l.before ? JSON.parse(l.before) : null, after: l.after ? JSON.parse(l.after) : null })) });
  }

  if (method === 'GET' && path === '/api/export.csv') {
    const { results } = await env.DB.prepare('SELECT * FROM entries ORDER BY list, id').all();
    const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = [['lista', 'nombre', 'normal', 'normal_sin_gluten', 'vegetariano', 'vegetariano_sin_gluten', 'total_eur', 'pagado_eur', 'falta_eur', 'actualizado'].join(',')];
    for (const r of results) {
      const isC = r.list === 'choripan';
      const tot = isC ? QTY.reduce((s, k) => s + r[k] * PRICES[k], 0) : '';
      const paid = isC ? QTY.reduce((s, k) => s + (r[paidKey(k)] || 0) * PRICES[k], 0) : '';
      lines.push([r.list, r.name, r.normal, r.normal_sg, r.veg, r.veg_sg, tot, paid, isC ? tot - paid : '', r.updated_at].map(esc).join(','));
    }
    return new Response('﻿' + lines.join('\n'), {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="halloween2026.csv"', 'cache-control': 'no-store' },
    });
  }

  // ---- Escritura ----
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    if (!checkCode(request, env) && !(env.ADMIN_KEY && isAdmin(request, env, url))) return bad('Hace falta el código de la fiesta para hacer cambios.', 401, { need_code: true });
  }

  const admin = isRealAdmin(request, env, url);
  const choriClosed = async (entry) => {
    if (admin) return null;
    if ((await getSetting(env, 'chori_locked')) === '1') return 'Los pedidos de choripán ya están cerrados. Si necesitas un cambio, habla con la comisión de cena.';
    if (entry && entry.locked) return 'Este pedido está bloqueado. Si necesitas un cambio, habla con la comisión de cena.';
    return null;
  };

  if (method === 'POST' && path === '/api/entries') {
    const b = await readBody(request);
    if (!b) return bad('Datos no válidos.');
    if (b.website) return json({ ok: true }); // trampa para bots
    const list = String(b.list || '');
    if (!LISTS.includes(list)) return bad('Lista desconocida.');
    let name = cleanName(b.name);
    if (list === 'alergias') name = name.slice(0, 60).replace(/^./, c => c.toUpperCase());
    if (!name) return bad('Escribe un nombre.');
    if (list === 'choripan') { const c = await choriClosed(null); if (c) return bad(c, 423); }
    const q = Object.fromEntries(QTY.map(k => [k, list === 'choripan' ? cleanQty(b[k]) : 0]));
    const dup = await env.DB.prepare('SELECT id FROM entries WHERE list = ? AND lower(name) = lower(?)').bind(list, name).first();
    if (dup) return bad(list === 'alergias' ? 'Ese alérgeno ya está en la lista 👍' : 'Ese nombre ya está en la lista. Puedes editarlo desde allí.', 409, { id: dup.id });
    const r = await env.DB.prepare(
      "INSERT INTO entries (list, name, normal, normal_sg, veg, veg_sg) VALUES (?, ?, ?, ?, ?, ?) RETURNING *"
    ).bind(list, name, q.normal, q.normal_sg, q.veg, q.veg_sg).first();
    await log(env, 'add', list, r.id, name, null, rowOut(r));
    return json({ ok: true, entry: rowOut(r) }, 201);
  }

  const m = path.match(/^\/api\/entries\/(\d+)$/);
  if (m && (method === 'PATCH' || method === 'PUT')) {
    const id = Number(m[1]);
    const before = await getEntry(env, id);
    if (!before) return bad('Esa entrada ya no existe (quizá alguien la ha quitado).', 404);
    const b = await readBody(request);
    if (!b) return bad('Datos no válidos.');
    let name = b.name !== undefined ? cleanName(b.name) : before.name;
    if (before.list === 'alergias') name = name.slice(0, 60).replace(/^./, c => c.toUpperCase());
    if (!name) return bad('Escribe un nombre.');
    const q = Object.fromEntries(QTY.map(k => [k, before.list === 'choripan' && b[k] !== undefined ? cleanQty(b[k]) : before[k]]));
    if (before.list === 'choripan') {
      const c = await choriClosed(before); if (c) return bad(c, 423);
      const low = QTY.filter(k => q[k] < (before[paidKey(k)] || 0));
      if (low.length) return bad('Ya habéis pagado parte del pedido: no se pueden quitar choripanes pagados, solo añadir más.', 409);
    }
    const r = await env.DB.prepare(
      "UPDATE entries SET name = ?, normal = ?, normal_sg = ?, veg = ?, veg_sg = ?, updated_at = datetime('now') WHERE id = ? RETURNING *"
    ).bind(name, q.normal, q.normal_sg, q.veg, q.veg_sg, id).first();
    await log(env, 'edit', before.list, id, name, rowOut(before), rowOut(r));
    return json({ ok: true, entry: rowOut(r) });
  }

  if (m && method === 'DELETE') {
    const id = Number(m[1]);
    const before = await getEntry(env, id);
    if (!before) return json({ ok: true });
    if (before.list === 'choripan') {
      const c = await choriClosed(before); if (c) return bad(c, 423);
      if (hasPaid(before)) return bad('Este pedido ya está pagado (o en parte) y no se puede quitar.', 409);
    }
    await env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
    await log(env, 'delete', before.list, id, before.name, rowOut(before), null);
    return json({ ok: true });
  }

  // Deshacer un borrado desde el historial
  const u = path.match(/^\/api\/log\/(\d+)\/restore$/);
  if (u && method === 'POST') {
    const l = await env.DB.prepare('SELECT * FROM log WHERE id = ?').bind(Number(u[1])).first();
    if (!l || l.action !== 'delete' || !l.before) return bad('Solo se pueden recuperar entradas borradas.');
    const e = JSON.parse(l.before);
    const exists = await env.DB.prepare('SELECT id FROM entries WHERE list = ? AND lower(name) = lower(?)').bind(e.list, e.name).first();
    if (exists) return bad('Ya hay una entrada con ese nombre en la lista.', 409);
    const r = await env.DB.prepare(
      "INSERT INTO entries (list, name, normal, normal_sg, veg, veg_sg) VALUES (?, ?, ?, ?, ?, ?) RETURNING *"
    ).bind(e.list, e.name, e.normal || 0, e.normal_sg || 0, e.veg || 0, e.veg_sg || 0).first();
    await log(env, 'restore', e.list, r.id, e.name, null, rowOut(r));
    return json({ ok: true, entry: rowOut(r) });
  }

  return bad('No encontrado.', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return bad('Error del servidor: ' + (err && err.message ? err.message : 'desconocido'), 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
