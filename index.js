require("dotenv").config();

// 🔐 PROTEÇÃO GLOBAL
let credentials=null;

try {
  credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  console.log("✅ GOOGLE_CREDENTIALS carregado");
} catch (e) {
  console.log("❌ ERRO ao ler GOOGLE_CREDENTIALS");
}const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const pino = require("pino");
const fs = require("fs");

const express = require("express");
const QRCode = require("qrcode");
const { google } = require("googleapis");

const app = express();

let sock = null;
let qrAtual = null;
let alunos = [];
const lidMap = {}; // 👈 adicionar esta linha


// ───────────── GOOGLE SHEETS ─────────────
async function carregarAlunos() {
  try {
    if (!credentials) {
      console.log("⛔ Sem credenciais, pulando carga de alunos");
      return;
    }

    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: "resposta automatica!A2:E",
    });

    alunos = (res.data.values || []).map((row, index) => ({
      linha: index + 2,
      telefone: row[0]?.replace(/\D/g, ""),
      nome: row[1],
      consultorNumero: row[2],
      consultorNome: row[3],
      jaRespondeu: (row[4] || "").toLowerCase(),
    }));

    console.log("✅ Alunos carregados:", alunos.length);
  } catch (e) {
    console.log("❌ ERRO AO CARREGAR ALUNOS:", e.message);
  }
}

// ───────────── ATUALIZAR PLANILHA ─────────────
async function marcarComoRespondido(linha) {
  try {
    if (!credentials) return;

    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `resposta automatica!E${linha}`, // ⚠️ corrigido
      valueInputOption: "RAW",
      requestBody: {
        values: [["SIM"]],
      },
    });

    console.log("✅ Atualizado linha", linha);
  } catch (e) {
    console.log("❌ ERRO AO ATUALIZAR:", e.message);
  }
}

// ───────────── RESPOSTA ─────────────
async function responderAluno(jid, numero) {
  const aluno = alunos.find((a) => a.telefone === numero);
console.log("🔎 Numero recebido:", numero);
console.log("📊 Telefones na planilha:", alunos.map(a => a.telefone));
  if (!aluno) {
    await sock.sendMessage(jid, {
      text: "❌ Não encontrei seu cadastro. Fale com o suporte.",
    });
    return;
  }

  // PRIMEIRA VEZ
  if (aluno.jaRespondeu !== "sim") {
    await sock.sendMessage(jid, {
      text:
        `👋 Olá, *${aluno.nome}*!\n\n` +
        `👨‍💼 *Seu consultor responsável:*\n\n` +
        `👤 ${aluno.consultorNome}\n` +
        `📱 ${aluno.consultorNumero}\n\n` +
        `👉 Entre em contato com ele para continuar seu atendimento.`,
    });

    await marcarComoRespondido(aluno.linha);
    aluno.jaRespondeu = "sim";
    return;
  }

  // SEGUNDA VEZ PRA FRENTE
 await sock.sendMessage(jid, {
  text:
    `👨‍💼 Entre em contato com seu consultor:\n\n👤 ${aluno.consultorNome}\n📱 ${aluno.consultorNumero}`,
});
}

// ───────────── WHATSAPP ─────────────
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth-resposta");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  

  sock.ev.on("creds.update", saveCreds);

  // Mapeia @lid para número real conforme contatos chegam
sock.ev.on("contacts.upsert", (contacts) => {
  for (const contact of contacts) {
    if (contact.id && contact.lid) {
      lidMap[contact.lid] = contact.id;
      console.log("🗺️ Mapeado:", contact.lid, "→", contact.id);
    }
  }
  console.log("📇 Total mapeados no lidMap:", Object.keys(lidMap).length);
});

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrAtual = qr;
      console.log("📱 QR gerado!");
    }

    if (connection === "open") {
      qrAtual = null;
      console.log("✅ Conectado!");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
          : true;

      if (shouldReconnect) conectar();
    }
  });

sock.ev.on("messages.upsert", async ({ messages }) => {
  for (const msg of messages) {
    if (!msg.message) continue;
    if (msg.key.fromMe) continue;

    // 👇 pega o número real direto do senderPn
    const senderPn = msg.key.senderPn;
    if (!senderPn) {
      console.log("🚫 Sem senderPn:", msg.key.remoteJid);
      continue;
    }

    const numero = senderPn.split("@")[0];

    const texto =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    if (!texto) continue;

    console.log("📩 Número REAL:", numero);
    console.log("💬 Texto:", texto);

    await responderAluno(msg.key.remoteJid, numero);
  }
});
}

// ───────────── ROTAS ─────────────
app.get("/qr", async (req, res) => {
  if (!qrAtual || sock?.user) {
    return res.send("Já conectado ou aguardando QR...");
  }

  const qrImage = await QRCode.toDataURL(qrAtual);
  res.send(`<img src="${qrImage}" width="300"/>`);
});

app.get("/logout", async (req, res) => {
  try {
    if (!sock) {
      return res.status(200).send("❌ Socket não iniciado");
    }

    try {
      await sock.logout();
    } catch (e) {
      console.log("⚠️ Logout falhou, continuando...");
    }

    const fs = require("fs");
    fs.rmSync("./auth-resposta", { recursive: true, force: true });

    sock = null;

    // 👇 ADICIONE ISSO AQUI (ESSENCIAL)
    setTimeout(() => conectar(), 1000);

    res.status(200).send("✅ Sessão limpa, novo QR será gerado");
  } catch (err) {
    console.log("❌ ERRO GERAL:", err);

    res.status(200).send("⚠️ Erro tratado, sessão resetada");
  }
});

// ───────────── START ─────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Rodando na porta", PORT));

conectar();

setTimeout(() => {
  carregarAlunos();
}, 5000);

// Atualiza a planilha a cada 5 minutos
setInterval(carregarAlunos, 5 * 60 * 1000);