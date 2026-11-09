// StrideMail Bridge v1.0 — solo @rentcar.rent
// IMAP mail.rentcar.rent:993 (SSL) + SMTP mail.rentcar.rent:465 (SSL)
// Las contraseñas NUNCA se guardan en disco: solo viven en memoria,
// asociadas a un token de sesión que expira (SESSION_TTL_HOURS, default 8h).
// Endpoints: GET /api/health, POST /api/login, GET /api/folders,
// GET /api/inbox, GET /api/message, POST /api/send, POST /api/logout
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const { simpleParser } = require("mailparser");

const PORT = process.env.PORT || 3000;
const HOST = "mail.rentcar.rent";
const IMAP_PORT = 993;
const SMTP_PORT = 465;
const STRICT_TLS = String(process.env.STRICT_TLS || "false").toLowerCase() === "true";
const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 8) * 60 * 60 * 1000;
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "").trim();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors({
  origin: (origin, cb) => {
    if (!ALLOWED_ORIGIN) return cb(null, true);
    if (!origin) return cb(null, true);
    return cb(null, origin === ALLOWED_ORIGIN);
  },
}));

// ---------- sesiones en memoria ----------
const sessions = new Map(); // token -> { email, password, createdAt }
function newToken() { return crypto.randomBytes(32).toString("hex"); }
function getSession(req) {
  const token = req.headers["x-token"] || req.query.token || "";
  if (!token || !sessions.has(token)) return null;
  const s = sessions.get(token);
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { sessions.delete(token); return null; }
  return { token, ...s };
}
function credentialsFrom(req) {
  // Prioridad: 1) token de sesión, 2) Basic Auth, 3) headers x-user/x-pass,
  // 4) query ?email=&password= (solo para la prueba rápida de StrideMail).
  const s = getSession(req);
  if (s) return s;
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Basic ")) {
    const [email, password] = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":");
    if (email && password) return { email, password };
  }
  const email = req.headers["x-user"] || req.query.email;
  const password = req.headers["x-pass"] || req.query.password;
  if (email && password) return { email: String(email), password: String(password) };
  return null;
}
function requireRentcar(email) {
  return typeof email === "string" && email.toLowerCase().endsWith("@rentcar.rent");
}
function imapConfig(email, password) {
  return {
    host: HOST, port: IMAP_PORT, secure: true,
    auth: { user: email, pass: password },
    tls: { servername: HOST, rejectUnauthorized: STRICT_TLS },
    logger: false,
  };
}
function smtpTransport(email, password) {
  return nodemailer.createTransport({
    host: HOST, port: SMTP_PORT, secure: true,
    auth: { user: email, pass: password },
    tls: { servername: HOST, rejectUnauthorized: STRICT_TLS },
  });
}
const FOLDER_MAP = {
  INBOX: "inbox", "INBOX.Sent": "sent", "INBOX.Drafts": "drafts",
  "INBOX.Trash": "trash", "INBOX.Junk": "junk", "INBOX.Spam": "junk",
  "INBOX.Archive": "archive",
};
function cleanFolder(path) { return FOLDER_MAP[path] || path.replace(/^INBOX\./, "").toLowerCase(); }

// ---------- salud ----------
app.get("/", (req, res) => res.json({ ok: true, service: "stridemail-bridge", domain: "rentcar.rent", imap: `${HOST}:${IMAP_PORT}`, smtp: `${HOST}:${SMTP_PORT}` }));
app.get("/api/health", (req, res) => res.json({ ok: true, service: "stridemail-bridge", domain: "rentcar.rent", imap: `${HOST}:${IMAP_PORT}`, smtp: `${HOST}:${SMTP_PORT}`, strictTls: STRICT_TLS, time: new Date().toISOString() }));

// ---------- login: valida contra IMAP y devuelve un token ----------
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: "Falta correo o contraseña." });
  if (!requireRentcar(email)) return res.status(403).json({ ok: false, error: "Solo cuentas @rentcar.rent." });
  const client = new ImapFlow(imapConfig(email, password));
  try {
    await client.connect();
    await client.logout();
    const token = newToken();
    sessions.set(token, { email, password, createdAt: Date.now() });
    res.json({ ok: true, token, email });
  } catch (e) {
    res.status(401).json({ ok: false, error: "No se pudo entrar al correo. Revisa el correo y la contraseña en Bluehost > Email Accounts." });
  }
});
app.post("/api/logout", (req, res) => {
  const token = req.headers["x-token"] || req.body?.token;
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// ---------- carpetas ----------
app.get("/api/folders", async (req, res) => {
  const creds = credentialsFrom(req);
  if (!creds) return res.status(401).json({ ok: false, error: "Sin sesión. Haz login primero." });
  if (!requireRentcar(creds.email)) return res.status(403).json({ ok: false, error: "Solo @rentcar.rent." });
  const client = new ImapFlow(imapConfig(creds.email, creds.password));
  try {
    await client.connect();
    const list = await client.list();
    await client.logout();
    const folders = list.map((f) => ({ path: f.path, name: cleanFolder(f.path), delimiter: f.delimiter }));
    if (!folders.some((f) => f.path === "INBOX")) folders.unshift({ path: "INBOX", name: "inbox" });
    res.json({ ok: true, folders });
  } catch (e) {
    res.status(401).json({ ok: false, error: "No se pudo listar carpetas. Revisa la contraseña." });
  }
});

// ---------- bandeja / lista de mensajes ----------
app.get("/api/inbox", async (req, res) => {
  const creds = credentialsFrom(req);
  if (!creds) return res.status(401).json({ ok: false, error: "Sin sesión. Haz login primero." });
  if (!requireRentcar(creds.email)) return res.status(403).json({ ok: false, error: "Solo @rentcar.rent." });
  const folder = req.query.folder || "INBOX";
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const client = new ImapFlow(imapConfig(creds.email, creds.password));
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      const total = client.mailbox.exists || 0;
      const from = Math.max(1, total - limit + 1);
      const messages = [];
      if (total > 0) {
        for await (const msg of client.fetch(`${from}:*`, { envelope: true, flags: true, uid: true, bodyStructure: true, source: true })) {
          try {
            const parsed = await simpleParser(msg.source);
            const hasPdf = (parsed.attachments || []).some((a) => (a.contentType || "").includes("pdf"));
            const hasImage = (parsed.attachments || []).some((a) => (a.contentType || "").startsWith("image/"));
            messages.push({
              uid: msg.uid, id: String(msg.uid),
              from: parsed.from?.text || msg.envelope.from?.[0]?.address || "",
              fromEmail: parsed.from?.value?.[0]?.address || msg.envelope.from?.[0]?.address || "",
              to: parsed.to?.text || "",
              subject: parsed.subject || msg.envelope.subject || "(sin asunto)",
              date: parsed.date ? parsed.date.toISOString() : msg.envelope.date ? msg.envelope.date.toISOString() : "",
              seen: msg.flags.has("\\Seen"), flagged: msg.flags.has("\\Flagged"),
              answered: msg.flags.has("\\Answered"),
              snippet: (parsed.text || "").slice(0, 200),
              bodyHtml: parsed.html || "",
              bodyText: parsed.text || "",
              hasAttachment: (parsed.attachments || []).length > 0,
              hasPdf, hasImage,
              attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename || "adjunto", contentType: a.contentType, size: a.size })),
            });
          } catch (e) { /* mensaje que no se pudo parsear: se salta, no rompe la lista */ }
        }
      }
      messages.reverse();
      res.json({ ok: true, folder, total, messages });
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    res.status(500).json({ ok: false, error: "No se pudo leer la bandeja: " + (e.message || "error IMAP") });
  }
});

// ---------- un mensaje ----------
app.get("/api/message", async (req, res) => {
  const creds = credentialsFrom(req);
  if (!creds) return res.status(401).json({ ok: false, error: "Sin sesión." });
  const folder = req.query.folder || "INBOX";
  const uid = Number(req.query.uid);
  if (!uid) return res.status(400).json({ ok: false, error: "Falta uid." });
  const client = new ImapFlow(imapConfig(creds.email, creds.password));
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(uid, { envelope: true, flags: true, source: true }, true);
      if (!msg) return res.status(404).json({ ok: false, error: "Mensaje no encontrado." });
      const parsed = await simpleParser(msg.source);
      res.json({ ok: true, uid, subject: parsed.subject || "", from: parsed.from?.text || "", to: parsed.to?.text || "", date: parsed.date ? parsed.date.toISOString() : "", bodyHtml: parsed.html || "", bodyText: parsed.text || "", attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename || "adjunto", contentType: a.contentType, size: a.size })) });
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Error al leer el mensaje." });
  }
});

// ---------- enviar ----------
app.post("/api/send", async (req, res) => {
  const creds = credentialsFrom(req);
  if (!creds) return res.status(401).json({ ok: false, error: "Sin sesión. Haz login primero." });
  if (!requireRentcar(creds.email)) return res.status(403).json({ ok: false, error: "Solo @rentcar.rent." });
  const { to, cc, bcc, subject, html, text } = req.body || {};
  if (!to || !subject) return res.status(400).json({ ok: false, error: "Falta destinatario o asunto." });
  try {
    const info = await smtpTransport(creds.email, creds.password).sendMail({
      from: creds.email, to, cc: cc || undefined, bcc: bcc || undefined,
      subject, html: html || undefined, text: text || html?.replace(/<[^>]+>/g, "") || "",
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    res.status(500).json({ ok: false, error: "No se pudo enviar: " + (e.message || "error SMTP") });
  }
});

// Limpieza de sesiones vencidas cada hora.
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(t);
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`StrideMail Bridge en puerto ${PORT} — ${HOST} IMAP ${IMAP_PORT} / SMTP ${SMTP_PORT} — strictTls=${STRICT_TLS}`));
