import { Client, GatewayIntentBits } from "discord.js";
import express from "express";
import fetch from "node-fetch";
import Tesseract from "tesseract.js";
import dotenv from "dotenv";

dotenv.config();

// --- Discord Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

// --- In-memory sessions ---
// sessions[userId] = {
//   playerName: string,
//   state: string,
//   kills: number|null,
//   robloxVerified: boolean,
//   channelId: string,
//   waitingForScreenshot: boolean
// }
const sessions = new Map();

// --- Express App for OAuth Callback ---
const app = express();

app.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).send("缺少 code 或 state");
  }

  const userId = state;
  const session = sessions.get(userId);
  if (!session) {
    return res.status(400).send("Session 過期或不存在");
  }

  try {
    // 1. 換取 Token
    const tokenResp = await fetch("https://apis.roblox.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.ROBLOX_CLIENT_ID,
        client_secret: process.env.ROBLOX_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.ROBLOX_REDIRECT_URI
      })
    });

    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      console.error("OAuth Token Error:", tokenData);
      return res.status(400).send("取得 Token 失敗");
    }

    // 2. 取得玩家資訊
    const userResp = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    const userData = await userResp.json();
    const robloxName = userData.name || userData.preferred_username;

    // 3. 比對名稱
    const matched =
      robloxName.toLowerCase() === session.playerName.toLowerCase();

    const channel = await client.channels.fetch(session.channelId);
    if (matched) {
      session.robloxVerified = true;
      channel.send(`✅ Roblox 驗證成功！名稱符合：**${robloxName}**`);
    } else {
      channel.send(
        `❌ Roblox 驗證失敗！你輸入的是 **${session.playerName}**，但 Roblox OAuth 回傳的是 **${robloxName}**`
      );
    }

    // 4. 如果兩邊都完成 → 最終驗證
    checkFinalVerification(userId);

    res.send("驗證完成！請回到 Discord 查看結果。");
  } catch (err) {
    console.error("[OAuth Error]", err);
    res.status(500).send("驗證過程發生錯誤");
  }
});

// --- 最終驗證檢查 ---
async function checkFinalVerification(userId) {
  const session = sessions.get(userId);
  if (!session) return;

  if (session.kills !== null && session.robloxVerified) {
    const channel = await client.channels.fetch(session.channelId);

    if (session.kills >= 3000) {
      channel.send(
        `🎉 所有驗證完成！玩家 **${session.playerName}** 擊殺數：**${session.kills}** ✅`
      );
    } else {
      channel.send(
        `❌ 驗證失敗！玩家 **${session.playerName}** 擊殺數只有 **${session.kills}**，必須 ≥ 3000 才能通過驗證。`
      );
    }

    // 驗證結束 → 清掉 session
    sessions.delete(userId);
  }
}

// --- Discord Bot Commands ---
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const content = message.content?.trim() || "";

  // Step 1: c!verify 玩家名稱
  if (content.startsWith("c!verify")) {
    const [, playerName] = content.split(/\s+/, 2);
    if (!playerName) {
      return message.reply("❌ 請輸入玩家名稱，例如：`c!verify YourName`");
    }

    const state = message.author.id;
    const session = sessions.get(state) || {
      kills: null,
      robloxVerified: false
    };
    session.playerName = playerName;
    session.state = state;
    session.channelId = message.channel.id;
    session.waitingForScreenshot = true;
    sessions.set(state, session);

    return message.channel.send({
    content:
      `🔍 玩家名稱 **${playerName}** 已記錄。\n請上傳「遊戲截圖」（顯示玩家名稱與擊殺數的畫面）。\n\n以下為範例：`,
    files: [
      "https://media.discordapp.net/attachments/1288861623427010693/1407203519114510437/image.png?ex=68a53fe7&is=68a3ee67&hm=9ce6b89e4f8020a2c72e136a3e5f2551fc898fb018d4654d6a259f4d9159d216&=&format=webp&quality=lossless"
    ]
  });
}

  // Step 2: 玩家上傳遊戲截圖
  if (message.attachments.size > 0) {
    const session = sessions.get(message.author.id);
    if (!session || !session.waitingForScreenshot) return;

    const imgUrl = message.attachments.first().url;
    await message.channel.send("📷 正在辨識遊戲截圖，請稍候...");

    try {
      const result = await Tesseract.recognize(imgUrl, "eng");
      const text = result.data.text;

      // 找出所有數字，直接取最大值
      const numbers = text.match(/\d+/g)?.map((n) => parseInt(n)) || [];
      if (numbers.length === 0) {
        return message.channel.send("⚠️ 無法辨識數字，請確認截圖清晰。");
      }

      const kills = Math.max(...numbers);
      session.kills = kills;
      session.waitingForScreenshot = false;
      sessions.set(message.author.id, session);

      // 發 OAuth 連結
      const authUrl =
        `https://apis.roblox.com/oauth/v1/authorize` +
        `?client_id=${process.env.ROBLOX_CLIENT_ID}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(process.env.ROBLOX_REDIRECT_URI)}` +
        `&scope=openid%20profile` +
        `&state=${session.state}`;

      await message.channel.send(
        `✅ 已辨識擊殺數：**${kills}**\n請點擊以下連結登入 Roblox 驗證：\n${authUrl}`
      );
    } catch (err) {
      console.error("[OCR Error]", err);
      message.channel.send("❌ OCR 辨識失敗，請再試一次。");
    }
  }
});

// --- Start Bot & Server ---
client.login(process.env.TOKEN);
app.get("/", (req, res) => {
  res.send(`
    <h1>✅ Discord 驗證機器人</h1>
    <p>這個網站用於支援 Roblox 玩家與 Discord 機器人的驗證流程。</p>
    <p>若你是一般使用者，請回到 Discord 伺服器使用 <code>c!verify</code> 指令完成驗證。</p>
    <hr/>
    <p>👉 測試用登入流程：</p>
    <a href="https://apis.roblox.com/oauth/v1/authorize?client_id=${process.env.ROBLOX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.ROBLOX_REDIRECT_URI)}&scope=openid%20profile&state=test">
      <button style="padding:10px 20px; font-size:16px; cursor:pointer;">登入 Roblox</button>
    </a>
  `);
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Express server running at http://localhost:${PORT}`);
});
