/**
 * POST /api/pedido — formulario "Solicitar cotización" de viales.com.ar
 *
 * Envía por la API HTTPS de Brevo:
 *   1. Aviso interno a MAIL_TO (reply-to = email del cliente).
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

const MARCAS = ['Agilent', 'Shimadzu', 'Thermo', 'Waters', 'Knauer', 'PerkinElmer', 'Otra'];
const TECNICAS = ['GC', 'GC-MS', 'HPLC', 'LC-MS'];

const MAX_ARCHIVOS = 3;
const MAX_BYTES_TOTAL = 3 * 1024 * 1024; // 3 MB reales (≈4 MB en base64; Vercel limita el cuerpo a 4,5 MB)
const EXT_PERMITIDAS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'xlsx', 'xls', 'csv', 'docx'];
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
  const marca = unaLinea(b.marca, 40);
  const modelo = unaLinea(b.modelo, 100);
  const tecnica = unaLinea(b.tecnica, 20);
  const detalle = limpiar(b.detalle, 3000);

  const errores = [];
  if (!nombre) errores.push('nombre');
  if (!apellido) errores.push('apellido');
  if (!empresa) errores.push('empresa');
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) errores.push('email');
  if (!detalle) errores.push('detalle');
  if (marca && !MARCAS.includes(marca)) errores.push('marca');
  if (tecnica && !TECNICAS.includes(tecnica)) errores.push('tecnica');

  const arch = validarArchivos(b.archivos);
  if (!arch.ok) errores.push('archivos');

  if (errores.length) return res.status(400).json({ ok: false, campos: errores });

  const nombreCompleto = nombre + ' ' + apellido;

  // ── 1. Aviso interno ──
  const cuerpoInterno =
    'NUEVO PEDIDO DE PRESUPUESTO — viales.com.ar\n\n' +
    'CONTACTO\n' +
    'Nombre: ' + nombreCompleto + '\n' +
    'Empresa: ' + empresa + '\n' +
    'Email: ' + email + '\n' +
    'Celular / WhatsApp: ' + (celular || '—') + '\n\n' +
    'EQUIPO\n' +
    'Marca: ' + (marca || '—') + '\n' +
    'Modelo: ' + (modelo || '—') + '\n' +
    'Técnica: ' + (tecnica || '—') + '\n\n' +
    'DETALLE DEL PEDIDO\n' +
    detalle + '\n\n' +
    (arch.lista.length
      ? 'Adjuntos: ' + arch.lista.map((a) => a.name).join(', ') + '\n\n'
      : 'Sin adjuntos.\n\n') +
    'Si es su primer pedido, el cliente recibió el link al alta (' + altaUrl + ').\n' +
    'Podés responder este mail: la respuesta le llega al cliente.';

  const payloadInterno = {
    sender: { name: 'Formulario viales.com.ar', email: from },
    to: to.map((e) => ({ email: e })),
    replyTo: { email: email, name: nombreCompleto },
    subject: '[Viales.com.ar] Nuevo pedido – ' + empresa + ' – ' + nombreCompleto,
    textContent: cuerpoInterno,
  };
  if (arch.lista.length) payloadInterno.attachment = arch.lista;

  const okInterno = await enviarBrevo(apiKey, payloadInterno);
  if (!okInterno) return res.status(502).json({ ok: false });

  // ── 2. Confirmación al cliente (si falla, el pedido igual se recibió) ──
  const textoCliente =
    'Hola ' + nombre + ':\n\n' +
    'Recibimos tu pedido y lo estamos revisando. Te respondemos con la cotización a la brevedad.\n\n' +
    'Si es tu primer pedido a AGS Analítica, te pedimos que completes el siguiente formulario para poder trabajar en él:\n' +
    altaUrl + '\n\n' +
    'Si ya sos cliente, no hace falta que hagas nada.\n\n' +
    'Saludos cordiales,\n' +
    'Consumibles · AGS Analítica\n' +
    'viales.com.ar';

  const htmlCliente =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0d1b35">' +
    '<p>Hola ' + esc(nombre) + ':</p>' +
    '<p>Recibimos tu pedido y lo estamos revisando. Te respondemos con la cotización a la brevedad.</p>' +
    '<p><strong>Si es tu primer pedido a AGS Analítica</strong>, te pedimos que completes el siguiente formulario para poder trabajar en él:<br>' +
    '<a href="' + esc(altaUrl) + '">' + esc(altaUrl) + '</a></p>' +
    '<p>Si ya sos cliente, no hace falta que hagas nada.</p>' +
    '<p>Saludos cordiales,<br>Consumibles · AGS Analítica<br>' +
    '<a href="https://www.viales.com.ar">viales.com.ar</a></p>' +
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
