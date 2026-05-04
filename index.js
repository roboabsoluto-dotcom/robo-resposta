require("dotenv").config();

const { google } = require("googleapis");

// 🔐 PROTEÇÃO GLOBAL
let credentials;

try {
  credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  console.log("✅ GOOGLE_CREDENTIALS carregado");
} catch (e) {
  console.log("❌ ERRO ao ler GOOGLE_CREDENTIALS");
}const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
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

// ───────────── GOOGLE SHEETS ─────────────
async function carregarAlunos() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
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
    console.error("Erro ao carregar alunos:", e.message);
  }
}

// ───────────── ATUALIZAR PLANILHA ─────────────
async function marcarComoRespondido(linha) {
  const auth = new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `resposta automatica!E${linha}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["SIM"]],
    },
  });

  console.log("✅ Atualizado para SIM linha", linha);
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
      `👨‍💼 Entre em contato com seu consultor:\n\n📱 ${aluno.consultorNumero}`,
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

    const jid = msg.key.remoteJid;
    if (!jid || jid.includes("@g.us")) continue;

    const numero = jid.split("@")[0].replace(/\D/g, "");

    // 🚫 FILTRO AQUI (EXATO LUGAR)
    if (numero.length < 12 || numero.length > 13) {
      console.log("🚫 Ignorado (ID inválido):", numero);
      continue;
    }

    console.log("📩 Mensagem de:", numero);

    await responderAluno(jid, numero);
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
  await sock.logout();
  fs.rmSync("./auth-resposta", { recursive: true, force: true });
  res.send("Desconectado!");
});

// ───────────── START ─────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Rodando na porta", PORT));

conectar();
carregarAlunos();

// Atualiza a planilha a cada 5 minutos
setInterval(carregarAlunos, 5 * 60 * 1000);