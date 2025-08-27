import { Client, GatewayIntentBits, AttachmentBuilder } from "discord.js";
import express from "express";
import fetch from "node-fetch";
import Tesseract from "tesseract.js";
import dotenv from "dotenv";
import Jimp from "jimp";

dotenv.config();

// --- Discord Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// --- In-memory sessions ---
const sessions = new Map();
const usedCodes = new Set();

// --- Express App ---
const app = express();

/** 小工具：產出簡單 HTML 頁面 */
const page = (title, body) => `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
:root { color-scheme: light dark; }
body{font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, "Apple Color Emoji","Segoe UI Emoji"; margin:0; background:#0b1220; color:#e5e7eb;}
.wrap{max-width:780px; margin:40px auto; padding:24px;}
.card{background:#111827; border:1px solid #1f2937; border-radius:16px; padding:24px; box-shadow: 0 10px 25px rgba(0,0,0,.25);}
h1{margin:0 0 12px 0; font-size:28px;}
p{line-height:1.7; margin:10px 0;}
code{background:#1f2937; padding:2px 6px; border-radius:6px;}
.btn{display:inline-block; padding:12px 18px; border-radius:10px; text-decoration:none; border:1px solid #374151;}
.primary{background:#2563eb; color:white; border-color:#1d4ed8;}
.muted{color:#9ca3af;}
.row{display:flex; gap:12px; flex-wrap:wrap; margin-top:12px;}
.ok{color:#34d399;}
.bad{color:#f87171;}
footer{margin-top:24px; font-size:13px; color:#9ca3af}
hr{border:0; height:1px; background:#1f2937; margin:18px 0;}
.kv{display:flex; gap:12px; align-items:center; flex-wrap:wrap}
.kv > div{flex:1 1 220px}
</style>
</head>
<body>
<div class="wrap">
<div class="card">
${body}
<footer>© ${new Date().getFullYear()} Discord Verify Bot</footer>
</div>
</div>
</body>
</html>`;

// --- Roblox OAuth Callback ---
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send("缺少 code 或 state");

  if (usedCodes.has(code)) {
    return res
      .status(400)
      .send(page("無效請求", `<h1>⚠️ 此驗證碼已經用過了，請重新發起驗證流程。</h1>`));
  }

  const session = sessions.get(state);
  if (!session) return res.status(400).send("Session 過期或不存在");

  try {
    const tokenResp = await fetch("https://apis.roblox.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.ROBLOX_CLIENT_ID,
        client_secret: process.env.ROBLOX_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.ROBLOX_REDIRECT_URI,
      }),
    });

    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      console.error("OAuth Token Error:", tokenData);
      return res.status(400).send(
        page("取得 Token 失敗", `<h1>❌ 取得 Token 失敗</h1><pre>${JSON.stringify(tokenData,null,2)}</pre>`)
      );
    }

    usedCodes.add(code);

    const userResp = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userResp.json();
    const robloxName = userData.name || userData.preferred_username || "(未知)";

    const isTest = !!session.isTest || state === "test" || !session.channelId;
    const nameMatched = isTest ? true : robloxName.toLowerCase() === session.playerName.toLowerCase();

    if (isTest) {
      const ok = nameMatched && (session.kills ?? 0) >= 3000;
      return res.send(
        page(
          ok ? "測試驗證成功" : "測試驗證資訊",
          `<h1>${ok ? "✅ 測試驗證成功" : "ℹ️ 測試驗證資訊"}</h1>
          <div class="kv">
            <div><p>Roblox 名稱：</p><p><b>${robloxName}</b></p></div>
            <div><p>模擬玩家名稱：</p><p><b>${session.playerName}</b></p></div>
            <div><p>模擬擊殺數：</p><p><b>${session.kills ?? "N/A"}</b></p></div>
          </div>
          <hr/>
          <p class="muted">此頁為 <b>審核測試</b> 頁面，實際驗證請至 Discord 使用 <code>c!verify</code>。</p>`
        )
      );
    }

    try {
      const channel = await client.channels.fetch(session.channelId);
      if (nameMatched) {
        session.robloxVerified = true;
        await channel.send(`✅ Roblox 驗證成功！名稱符合：**${robloxName}**`);
      } else {
        await channel.send(`❌ Roblox 驗證失敗！你輸入的是 **${session.playerName}**，但 OAuth 回傳的是 **${robloxName}**`);
      }
      await checkFinalVerification(state);
      return res.send(page("驗證完成", `<h1>✅ 已完成 OAuth</h1><p>請回到 Discord 查看最終結果。</p>`));
    } catch (e) {
      console.error("[Discord Send Error]", e);
      return res.status(500).send(page("Discord 傳送失敗", `<h1>⚠️ Discord 傳送失敗</h1><pre>${String(e)}</pre>`));
    }
  } catch (err) {
    console.error("[OAuth Error]", err);
    return res.status(500).send(page("驗證過程發生錯誤", `<h1>❌ 驗證過程發生錯誤</h1><pre>${String(err)}</pre>`));
  }
});

// --- 驗證檢查 & 角色管理 ---
async function checkFinalVerification(userId) {
  const session = sessions.get(userId);
  if (!session) return;

  if (session.kills !== null && session.robloxVerified) {
    try {
      const channel = await client.channels.fetch(session.channelId);
      const guild = channel.guild;
      const member = await guild.members.fetch(session.state); // session.state 是 Discord User ID

      if (session.kills >= 3000) {
        // 驗證成功訊息
        await channel.send(
          `🎉 所有驗證完成！玩家 **${session.playerName}** 擊殺數：**${session.kills}** ✅`
        );

        const roleToAdd = "1401164021041860788";
        const roleToRemove = "1393969444073639986";

        // 只有在沒有角色時才增加 / 移除
        if (!member.roles.cache.has(roleToAdd)) {
          await member.roles.add(roleToAdd).catch(console.error);
        }
        if (member.roles.cache.has(roleToRemove)) {
          await member.roles.remove(roleToRemove).catch(console.error);
        }

      } else {
        await channel.send(
          `❌ 驗證失敗！玩家 **${session.playerName}** 擊殺數只有 **${session.kills}**，必須 ≥ 3000 才能通過驗證。`
        );
      }
    } catch (e) {
      console.error("[Discord Send Error - Finalize]", e);
    } finally {
      sessions.delete(userId);
    }
  }
}


// --- Discord Bot Commands ---
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const content = (message.content || "").trim();

  // Step 1: c!verify 玩家名稱
  if (content.startsWith("c!verify")) {
    const [, playerName] = content.split(/\s+/, 2);
    if (!playerName) return message.reply("❌ 請輸入玩家名稱，例如：c!verify YourName");

    const state = message.author.id;
    const session = {
      playerName,
      state,
      kills: null,
      robloxVerified: false,
      channelId: message.channel.id,
      waitingForScreenshot: true,
    };
    sessions.set(state, session);

    return message.channel.send({
      content: `🔍 玩家名稱 **${playerName}** 已記錄。\n請上傳「遊戲截圖」（顯示玩家名稱與擊殺數的畫面）。\n\n以下為範例：`,
      files: ["image.png"],
    });
  }

  // Step 2: 玩家上傳截圖 → OCR
  if (message.attachments.size > 0) {
    const session = sessions.get(message.author.id);
    if (!session || !session.waitingForScreenshot) return;

    const imgUrl = message.attachments.first().url;
    await message.channel.send("📷 正在增強圖片並辨識，請稍候...");

    try {
      const image = await Jimp.read(imgUrl);
      image
        .resize(image.bitmap.width * 2, Jimp.AUTO)


      const buffer = await image.getBufferAsync(Jimp.MIME_PNG);

      const processedAttachment = new AttachmentBuilder(buffer, { name: "processed.png" });
      await message.channel.send({ content: "🖼️ 已處理過的圖片：", files: [processedAttachment] });

      const { data } = await Tesseract.recognize(buffer, "eng");
      const text = data.text || "";

      const numbers = (text.match(/\d[\d,]*/g) || []).map(n => parseInt(n.replace(/,/g, ""), 10)).filter(Number.isFinite);

      if (numbers.length === 0) {
        return message.channel.send("⚠️ 無法辨識數字，請確認截圖清晰（建議關閉動態濾鏡、用原圖上傳）。");
      }

      const kills = Math.max(...numbers);
      session.kills = kills;
      session.waitingForScreenshot = false;
      sessions.set(message.author.id, session);

      const authUrl = `https://apis.roblox.com/oauth/v1/authorize?client_id=${process.env.ROBLOX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.ROBLOX_REDIRECT_URI)}&scope=openid%20profile&state=${session.state}`;

      await message.channel.send(`✅ 已辨識擊殺數：**${kills}**\n請點擊以下連結登入 Roblox 驗證：\n${authUrl}`);
    } catch (err) {
      console.error("[OCR Error]", err);
      await message.channel.send("❌ 圖片處理或 OCR 失敗，請再試一次。");
    }
  }
});

// --- 首頁、Privacy、Terms、Health Check (同原本) ---
app.get("/", (req, res) => {
  sessions.set("test", { playerName: "DemoPlayer", state: "test", kills: 5000, robloxVerified: false, channelId: null, waitingForScreenshot: false, isTest: true });
  const authUrl = `https://apis.roblox.com/oauth/v1/authorize?client_id=${process.env.ROBLOX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.ROBLOX_REDIRECT_URI)}&scope=openid%20profile&state=test`;
  res.send(page("Discord 驗證機器人", `<h1>✅ Discord 驗證機器人</h1><p>這個網站用於支援 Roblox 與 Discord 的身分驗證流程。</p><div class="row"><a class="btn primary" href="${authUrl}">登入 Roblox（測試）</a></div>`));
});

app.get("/privacy", (req, res) => res.send(page("Privacy Policy", `<h1>Privacy Policy</h1><p>We only process information necessary to complete Roblox OAuth and Discord verification...</p>`)));
app.get("/terms", (req, res) => res.send(page("Terms of Service", `<h1>Terms of Service</h1><p>By using this verification, you agree to follow the rules...</p>`)));
app.get("/health", (req, res) => res.type("text").send("ok"));

// --- Start server & bot ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 HTTP server running on port ${PORT}`));
client.login(process.env.TOKEN);
