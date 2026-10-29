/**
 * POST /api/pedido — formulario "Solicitar cotización" de viales.com.ar
 *
 * Envía por la API HTTPS de Brevo:
 *   1. Aviso interno a MAIL_TO, con botón "Responder al cliente" (mailto) y advertencia de no usar "Responder".
 *   2. Confirmación automática al cliente, con link al alta.
 *
 * Variables de entorno (Vercel → Settings → Environment Variables):
 *   BREVO_API_KEY    clave de la API de Brevo (obligatoria)
 *   MAIL_FROM        remitente ya validado en Brevo, ej. consumibles@agsanalitica.com (obligatoria)
 *   MAIL_TO          destinatarios internos separados por coma (obligatoria)
 *   MAIL_FROM_NAME   nombre visible del remitente (opcional, default "Consumibles · AGS Analítica")
 *   MAIL_REPLY_TO    reply-to de la confirmación al cliente (opcional, default MAIL_FROM)
 *   ALTA_URL         link al alta de cliente (opcional, default https://www.agsanalitica.com/alta)
 *
 * La clave NUNCA va en el repo ni en el HTML.
 */

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

// URL pública del sitio: de ahí se cargan los logos de la firma (/email/logo-*.png).
const SITE_URL = (process.env.SITE_URL || 'https://www.viales.com.ar').replace(/\/+$/, '');
const LOGO_AGS_ALTO = 64; // px con que se muestra el logo de AGS en la firma (el PNG es 428×184)
const LOGO_AGS_ANCHO = Math.round((LOGO_AGS_ALTO * 428) / 184);

const MARCAS = ['Agilent', 'Shimadzu', 'Thermo', 'Waters', 'Knauer', 'PerkinElmer', 'Otra'];
const TECNICAS = ['GC', 'GC-MS', 'HPLC', 'LC-MS'];

const MAX_ARCHIVOS = 3;
const MAX_BYTES_TOTAL = 3 * 1024 * 1024; // 3 MB reales (≈4 MB en base64; Vercel limita el cuerpo a 4,5 MB)
const EXT_PERMITIDAS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'xlsx', 'xls', 'csv', 'docx'];
const MAX_ITEMS = 30;
const MIN_MS_FORM = 3000; // un humano tarda más que esto en completar el form

function limpiar(valor, max) {
  return String(valor == null ? '' : valor)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function unaLinea(valor, max) {
  return limpiar(valor, max).replace(/\s+/g, ' ');
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function origenPermitido(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // sin Origin (ej. pruebas con curl): lo dejamos pasar, el resto de las defensas siguen
  try {
    const host = new URL(origin).hostname;
    return (
      host === 'viales.com.ar' ||
      host === 'www.viales.com.ar' ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.vercel.app')
    );
  } catch (e) {
    return false;
  }
}

function validarArchivos(archivos) {
  if (archivos == null) return { ok: true, lista: [] };
  if (!Array.isArray(archivos) || archivos.length > MAX_ARCHIVOS) return { ok: false };
  let total = 0;
  const lista = [];
  for (const a of archivos) {
    if (!a || typeof a.name !== 'string' || typeof a.content !== 'string') return { ok: false };
    const nombre = a.name.replace(/[^\w.\- ()áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 100);
    const ext = (nombre.split('.').pop() || '').toLowerCase();
    if (!EXT_PERMITIDAS.includes(ext)) return { ok: false };
    if (!/^[A-Za-z0-9+/=\s]+$/.test(a.content)) return { ok: false };
    const contenido = a.content.replace(/\s/g, '');
    const bytes = Math.floor((contenido.length * 3) / 4);
    total += bytes;
    if (total > MAX_BYTES_TOTAL) return { ok: false };
    lista.push({ name: nombre, content: contenido });
  }
  return { ok: true, lista };
}

function validarItems(items) {
  if (items == null) return { ok: true, lista: [] };
  if (!Array.isArray(items) || items.length > MAX_ITEMS) return { ok: false };
  const lista = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') return { ok: false };
    const item = {
      marca: unaLinea(it.marca, 40),
      modelo: unaLinea(it.modelo, 100),
      tecnica: unaLinea(it.tecnica, 20),
      producto: unaLinea(it.producto, 200),
      cantidad: unaLinea(it.cantidad, 40),
    };
    if (!item.producto) continue;
    if (item.marca && !MARCAS.includes(item.marca)) return { ok: false };
    if (item.tecnica && !TECNICAS.includes(item.tecnica)) return { ok: false };
    lista.push(item);
  }
  return { ok: true, lista };
}

const equipoDe = (it) => [it.marca, it.modelo, it.tecnica].filter(Boolean).join(' · ') || '—';

function tablaItemsHtml(lista) {
  const th = 'padding:7px 10px;text-align:left;font-size:12px;color:#667085;font-weight:normal;border-bottom:1px solid #d8dfe8';
  const td = 'padding:7px 10px;border-bottom:1px solid #eef1f5;vertical-align:top';
  return (
    '<table style="border-collapse:collapse;width:100%;margin-bottom:14px;font-size:14px">' +
    '<tr><th style="' + th + '">#</th><th style="' + th + '">Producto</th><th style="' + th + '">Equipo</th><th style="' + th + '">Cant.</th></tr>' +
    lista.map((it, i) =>
      '<tr><td style="' + td + ';color:#667085">' + (i + 1) + '</td><td style="' + td + '">' + esc(it.producto) +
      '</td><td style="' + td + ';color:#475467">' + esc(equipoDe(it)) + '</td><td style="' + td + ';white-space:nowrap">' +
      esc(it.cantidad || '—') + '</td></tr>').join('') +
    '</table>'
  );
}

function listaItemsTexto(lista) {
  return lista.map((it, i) =>
    (i + 1) + '. ' + it.producto + (it.cantidad ? ' × ' + it.cantidad : '') + '  [' + equipoDe(it) + ']').join('\n');
}

async function enviarBrevo(apiKey, payload) {
  const r = await fetch(BREVO_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });
  if (r.status !== 201) {
    const detalle = await r.text().catch(() => '');
    // Se registra en los logs de Vercel; nunca se expone al visitante ni se imprime la clave.
    console.error('[pedido] Brevo respondió ' + r.status + ': ' + detalle);
    return false;
  }
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false });
  }
  if (!origenPermitido(req)) {
    return res.status(403).json({ ok: false });
  }

  const apiKey = process.env.BREVO_API_KEY;
  const from = process.env.MAIL_FROM;
  const to = (process.env.MAIL_TO || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!apiKey || !from || to.length === 0) {
    console.error('[pedido] Faltan variables de entorno (BREVO_API_KEY, MAIL_FROM, MAIL_TO).');
    return res.status(500).json({ ok: false });
  }
  const fromName = process.env.MAIL_FROM_NAME || 'Consumibles · AGS Analítica';
  const replyToCliente = process.env.MAIL_REPLY_TO || from;
  const altaUrl = process.env.ALTA_URL || 'https://www.agsanalitica.com/alta';

  let b = req.body;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch (e) {
      b = null;
    }
  }
  if (!b || typeof b !== 'object') return res.status(400).json({ ok: false });

  // Honeypot: si viene completo es un bot; respondemos éxito para no delatar el mecanismo.
  if (limpiar(b.sitio_web, 200) !== '') return res.status(200).json({ ok: true });

  // Tiempo mínimo desde que se mostró el form (también se descarta en silencio).
  const t = Number(b.t);
  if (Number.isFinite(t) && t < MIN_MS_FORM) return res.status(200).json({ ok: true });

  const nombre = unaLinea(b.nombre, 80);
  const apellido = unaLinea(b.apellido, 80);
  const empresa = unaLinea(b.empresa, 150);
  const email = unaLinea(b.email, 150);
  const celular = unaLinea(b.celular, 40);
  const detalle = limpiar(b.detalle, 3000);
  const its = validarItems(b.items);

  const errores = [];
  if (!nombre) errores.push('nombre');
  if (!apellido) errores.push('apellido');
  if (!empresa) errores.push('empresa');
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) errores.push('email');
  if (!its.ok) errores.push('items');
  else if (!its.lista.length && !detalle) errores.push('detalle');

  const arch = validarArchivos(b.archivos);
  if (!arch.ok) errores.push('archivos');

  if (errores.length) return res.status(400).json({ ok: false, campos: errores });

  const nombreCompleto = nombre + ' ' + apellido;

  // ── 1. Aviso interno ──
  // El reply-to NO es el cliente: Gmail marca como posible phishing un mail "de agsanalitica.com"
  // cuyas respuestas van a otra dirección. En su lugar va un enlace "Responder al cliente" (mailto).
  const mailtoCliente =
    'mailto:' + email +
    '?subject=' + encodeURIComponent('Re: tu pedido en viales.com.ar') +
    '&body=' + encodeURIComponent('Hola ' + nombre + ':\n\n');

  const filaHtml = (k, v) =>
    '<tr><td style="padding:4px 14px 4px 0;color:#667085;white-space:nowrap;vertical-align:top">' + esc(k) +
    '</td><td style="padding:4px 0;color:#0d1b35">' + esc(v) + '</td></tr>';

  const htmlInterno =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#0d1b35;max-width:640px">' +
    '<div style="background:#fff4cc;border:1px solid #e0a800;border-radius:8px;padding:12px 14px;margin-bottom:16px">' +
    '<strong>No uses “Responder”.</strong> Esa respuesta vuelve a consumibles@. ' +
    'Usá el botón <strong>Responder al cliente</strong></div>' +
    '<p style="margin:0 0 18px"><a href="' + esc(mailtoCliente) + '" ' +
    'style="display:inline-block;background:#0d1b35;color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 22px;border-radius:100px">' +
    'Responder al cliente</a></p>' +
    '<h3 style="margin:0 0 6px;font-size:15px">Nuevo pedido de presupuesto — viales.com.ar</h3>' +
    '<table style="border-collapse:collapse;margin-bottom:14px">' +
    filaHtml('Nombre', nombreCompleto) +
    filaHtml('Empresa', empresa) +
    filaHtml('Email', email) +
    filaHtml('Celular / WhatsApp', celular || '—') +
    '</table>' +
    (its.lista.length
      ? '<div style="color:#667085;margin-bottom:4px">Ítems del pedido (' + its.lista.length + ')</div>' + tablaItemsHtml(its.lista)
      : '') +
    (detalle
      ? '<div style="color:#667085;margin-bottom:4px">Comentarios</div>' +
        '<div style="background:#f1f5f9;border-radius:8px;padding:12px 14px;white-space:pre-wrap;margin-bottom:14px">' + esc(detalle) + '</div>'
      : '') +
    '<p style="margin:0 0 6px">' +
    (arch.lista.length ? 'Adjuntos: ' + esc(arch.lista.map((a) => a.name).join(', ')) : 'Sin adjuntos.') + '</p>' +
    '<p style="margin:0;color:#667085;font-size:13px">Si es su primer pedido, el cliente recibió el link al alta (' + esc(altaUrl) + ').</p>' +
    '</div>';

  const cuerpoInterno =
    'NO USES “RESPONDER”. Esa respuesta vuelve a consumibles@.\n' +
    'Usá este enlace para contestarle al cliente: ' + mailtoCliente + '\n\n' +
    'NUEVO PEDIDO DE PRESUPUESTO — viales.com.ar\n\n' +
    'CONTACTO\n' +
    'Nombre: ' + nombreCompleto + '\n' +
    'Empresa: ' + empresa + '\n' +
    'Email: ' + email + '\n' +
    'Celular / WhatsApp: ' + (celular || '—') + '\n\n' +
    (its.lista.length ? 'ÍTEMS DEL PEDIDO\n' + listaItemsTexto(its.lista) + '\n\n' : '') +
    (detalle ? 'COMENTARIOS\n' + detalle + '\n\n' : '') +
    (arch.lista.length
      ? 'Adjuntos: ' + arch.lista.map((a) => a.name).join(', ') + '\n\n'
      : 'Sin adjuntos.\n\n') +
    'Si es su primer pedido, el cliente recibió el link al alta (' + altaUrl + ').';

  const payloadInterno = {
    sender: { name: 'Formulario viales.com.ar', email: from },
    to: to.map((e) => ({ email: e })),
    replyTo: { email: from },
    subject: '[Viales.com.ar] Nuevo pedido – ' + empresa + ' – ' + nombreCompleto,
    htmlContent: htmlInterno,
    textContent: cuerpoInterno,
  };
  if (arch.lista.length) payloadInterno.attachment = arch.lista;

  const okInterno = await enviarBrevo(apiKey, payloadInterno);
  if (!okInterno) return res.status(502).json({ ok: false });

  // ── 2. Confirmación al cliente (si falla, el pedido igual se recibió) ──
  const textoCliente =
    'Hola ' + nombre + ':\n\n' +
    'Recibimos tu pedido y lo estamos revisando. Te respondemos con la cotización a la brevedad.\n\n' +
    (its.lista.length ? 'Tu pedido:\n' + listaItemsTexto(its.lista) + '\n\n' : '') +
    'Si es tu primer pedido a AGS Analítica, te pedimos que completes el siguiente formulario para poder trabajar en él:\n' +
    altaUrl + '\n\n' +
    'Si ya sos cliente, no hace falta que hagas nada.\n\n' +
    'Saludos cordiales,\n' +
    'AGS Analítica | Consumibles\n' +
    SITE_URL;

  const htmlCliente =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0d1b35">' +
    '<p>Hola ' + esc(nombre) + ':</p>' +
    '<p>Recibimos tu pedido y lo estamos revisando. Te respondemos con la cotización a la brevedad.</p>' +
    (its.lista.length ? '<p style="margin-bottom:6px">Tu pedido:</p>' + tablaItemsHtml(its.lista) : '') +
    '<p><strong>Si es tu primer pedido a AGS Analítica</strong>, te pedimos que completes el siguiente formulario para poder trabajar en él:<br>' +
    // El texto del enlace NO repite la URL: Brevo reescribe el href con su redirector y un texto con
    // otro dominio a la vista es una señal típica de phishing. El texto plano conserva la URL directa.
    '<a href="' + esc(altaUrl) + '">Completar el alta de cliente</a></p>' +
    '<p>Si ya sos cliente, no hace falta que hagas nada.</p>' +
    '<p style="margin-bottom:8px">Saludos cordiales,<br>AGS Analítica | Consumibles</p>' +
    // Las imágenes tienen que estar publicadas en una URL pública: se sirven desde /email/ del propio sitio.
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px"><tr>' +
    '<td style="padding-right:18px;vertical-align:middle">' +
    '<img src="' + esc(SITE_URL) + '/email/logo-ags.png" alt="AGS Analítica" width="' + LOGO_AGS_ANCHO + '" height="' + LOGO_AGS_ALTO + '" ' +
    'style="display:block;width:' + LOGO_AGS_ANCHO + 'px;height:' + LOGO_AGS_ALTO + 'px;border:0"></td>' +
    '<td style="border-left:1px solid #cfd6e2;padding-left:18px;vertical-align:middle">' +
    '<a href="' + esc(SITE_URL) + '"><img src="' + esc(SITE_URL) + '/email/logo-viales.png" alt="viales.com.ar" ' +
    'width="150" height="18" style="display:block;width:150px;height:auto;border:0"></a></td>' +
    '</tr></table>' +
    '</div>';

  const okCliente = await enviarBrevo(apiKey, {
    sender: { name: fromName, email: from },
    to: [{ email: email, name: nombreCompleto }],
    replyTo: { email: replyToCliente },
    subject: 'Recibimos tu pedido – viales.com.ar',
    textContent: textoCliente,
    htmlContent: htmlCliente,
  });
  if (!okCliente) console.error('[pedido] La confirmación al cliente no se pudo enviar (el aviso interno sí salió).');

  return res.status(200).json({ ok: true });
};
