require("dotenv").config();

let credentials = null;
try {
  credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  console.log("✅ GOOGLE_CREDENTIALS carregado");
} catch (e) {
  console.log("❌ ERRO ao ler GOOGLE_CREDENTIALS");
}

const {
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
let linhasConsultores = new Set();
let primeiraLeituraConsultores = true;
const lidMap = {};

// ───────────── GOOGLE SHEETS ─────────────
async function carregarAlunos() {
  try {
    if (!credentials) {
      console.log("⛔ Sem credenciais, pulando carga de alunos");
      return;
    }
    const auth = new google.auth.GoogleAuth({
      credentials,
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
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `resposta automatica!E${linha}`,
      valueInputOption: "RAW",
      requestBody: { values: [["SIM"]] },
    });
    console.log("✅ Atualizado linha", linha);
  } catch (e) {
    console.log("❌ ERRO AO ATUALIZAR:", e.message);
  }
}

// ───────────── MONITORAR CONSULTORES ─────────────
async function monitorarConsultores() {
  try {
    if (!credentials) return;
    if (!sock) {
      console.log("⚠️ Socket ainda não pronto, pulando monitoramento");
      return;
    }
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: "Requerimentos_Matricula!A2:W",
    });
    const dados = res.data.values || [];

    for (let index = 0; index < dados.length; index++) {
      const linha = index + 2;
      if (linhasConsultores.has(linha)) continue;
      linhasConsultores.add(linha);
      if (primeiraLeituraConsultores) continue;

      const row = dados[index];
      const nomeAluno = row[2];
      const telefoneAluno = row[5]?.replace(/\D/g, "");
      const cursoAluno = row[13];
      const nomeConsultor = row[21];
      const whatsappConsultor = row[22]?.replace(/\D/g, "");

      if (!whatsappConsultor) continue;

      const jid = whatsappConsultor + "@s.whatsapp.net";
      await sock.sendMessage(jid, {
        text:
          `🎉 Olá, *${nomeConsultor}*!\n\n` +
          `Um novo aluno acabou de se inscrever.\n\n` +
          `👤 *Nome:* ${nomeAluno}\n` +
          `📞 *Telefone:* ${telefoneAluno}\n` +
          `📚 *Curso:* ${cursoAluno}\n\n` +
          `✅ Verifique os detalhes no sistema e realize o contato o quanto antes.\n\n` +
          `💪 Um atendimento rápido aumenta as chances de conversão.\n\n` +
          `🚀 Excelente atendimento e boas matrículas!`,
      });
      console.log("✅ Mensagem enviada para:", nomeConsultor);
    }
    primeiraLeituraConsultores = false;
  } catch (e) {
    console.log("❌ ERRO MONITORAMENTO:", e.message);
  }
}

// ───────────── RESPOSTA AO ALUNO ─────────────
async function responderAluno(jid, numero) {
  const aluno = alunos.find((a) => a.telefone === numero);
  console.log("🔎 Numero recebido:", numero);
  console.log("📊 Telefones na planilha:", alunos.map((a) => a.telefone));

  if (!aluno) {
    await sock.sendMessage(jid, {
      text: "❌ Não encontrei seu cadastro. Fale com o suporte.",
    });
    return;
  }

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

  await sock.sendMessage(jid, {
    text: `👨‍💼 Entre em contato com seu consultor:\n\n👤 ${aluno.consultorNome}\n📱 ${aluno.consultorNumero}`,
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

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const contact of contacts) {
      if (contact.id && contact.lid) {
        lidMap[contact.lid] = contact.id;
        console.log("🗺️ Mapeado:", contact.lid, "→", contact.id);
      }
    }
    console.log("📇 Total mapeados:", Object.keys(lidMap).length);
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

      const remoteJid = msg.key.remoteJid;
      let numero;

      if (remoteJid.endsWith("@s.whatsapp.net")) {
        numero = remoteJid.replace("@s.whatsapp.net", "");
      } else if (remoteJid.endsWith("@g.us")) {
        numero = (msg.key.participant || "").replace("@s.whatsapp.net", "");
      } else {
        console.log("🚫 JID desconhecido:", remoteJid);
        continue;
      }

      if (!numero) {
        console.log("🚫 Não foi possível extrair número de:", remoteJid);
        continue;
      }

      const texto =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text;

      if (!texto) continue;

      console.log("📩 Número REAL:", numero);
      console.log("💬 Texto:", texto);

      await responderAluno(remoteJid, numero);
    }
  });
} // ← ✅ fecha conectar() aqui

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
    if (!sock) return res.status(200).send("❌ Socket não iniciado");
    try {
      await sock.logout();
    } catch (e) {
      console.log("⚠️ Logout falhou, continuando...");
    }
    fs.rmSync("./auth-resposta", { recursive: true, force: true });
    sock = null;
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
  monitorarConsultores();
}, 5000);

setInterval(monitorarConsultores, 60 * 1000);