export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return renderHomePage(env);
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      const wallet = await getWallet(env.DB);
      return json({
        totalMinutes: wallet.total_minutes,
        remainingMinutes: wallet.remaining_minutes,
      });
    }

    if (request.method === "POST" && url.pathname === "/line/webhook") {
      return handleLineWebhook(request, env);
    }

    return json(
      {
        ok: false,
        error: "Not found",
      },
      404
    );
  },
};

async function handleLineWebhook(request, env) {
  const signature = request.headers.get("x-line-signature");

  if (!signature) {
    return json(
      {
        ok: false,
        error: "Missing x-line-signature",
      },
      401
    );
  }

  const bodyText = await request.text();

  const valid = await verifyLineSignature(
    bodyText,
    env.LINE_CHANNEL_SECRET,
    signature
  );

  if (!valid) {
    return json(
      {
        ok: false,
        error: "Invalid signature",
      },
      401
    );
  }

  let body;

  try {
    body = JSON.parse(bodyText);
  } catch {
    return json(
      {
        ok: false,
        error: "Invalid JSON",
      },
      400
    );
  }

  for (const event of body.events || []) {
    await handleLineEvent(event, env);
  }

  return json({
    ok: true,
  });
}

async function handleLineEvent(event, env) {
  if (event.type !== "message") return;
  if (event.message?.type !== "text") return;

  const lineUserId = event.source?.userId;
  const replyToken = event.replyToken;
  const text = event.message.text?.trim();

  if (!lineUserId || !replyToken || !text) return;

  const role = getRole(env, lineUserId);

  if (!role) {
    await replyMessage(
      env.LINE_CHANNEL_ACCESS_TOKEN,
      replyToken,
      "このアカウントでは利用できません。"
    );
    return;
  }

  await upsertUser(env.DB, lineUserId, role);

  const result = await processCommand(env, role, lineUserId, text);

  await replyMessage(
    env.LINE_CHANNEL_ACCESS_TOKEN,
    replyToken,
    result.message,
    result.quickReply
  );
}

function getRole(env, lineUserId) {
  if (lineUserId === env.OWNER_LINE_USER_ID) return "owner";
  if (lineUserId === env.PARTNER_LINE_USER_ID) return "partner";
  return null;
}

async function processCommand(env, role, lineUserId, text) {
  const normalized = normalizeText(text);

  if (isStatusCommand(normalized)) {
    const wallet = await getWallet(env.DB);
    return {
      message: formatStatus(wallet),
      quickReply: getQuickReply(role),
    };
  }

  if (role === "partner") {
    return processPartnerCommand(env, lineUserId, normalized, text);
  }

  return processOwnerCommand(env, lineUserId, normalized, text);
}

async function processPartnerCommand(env, lineUserId, normalized, rawText) {
  if (normalized === "かまちょ") {
    await setUserState(env.DB, lineUserId, "awaiting_use_minutes");

    return {
      message: "どれくらいかまってほしい？\n(分数の数字のみを送ってね)",
      quickReply: null,
    };
  }

  const state = await getUserState(env.DB, lineUserId);
  const minutes = state === "awaiting_use_minutes"
    ? parseMinutesOnly(normalized)
    : null;

  if (minutes === null) {
    return {
      message:
        "使える操作は「残り」と「かまちょ」です。\n" +
        "時間を使いたいときは「かまちょ」と送ってね。",
      quickReply: getQuickReply("partner"),
    };
  }

  if (minutes <= 0) {
    return {
      message: "使用する時間は1分以上で入力してください。",
      quickReply: null,
    };
  }

  const result = await updateWallet(env.DB, {
    actorLineUserId: lineUserId,
    eventType: "use",
    minutes,
    rawMessage: rawText,
  });

  if (!result.ok) {
    return {
      message:
        "残り時間が足りません。\n" +
        `現在の残り時間は ${formatMinutes(result.beforeRemaining)} です。`,
      quickReply: getQuickReply("partner"),
    };
  }

  await clearUserState(env.DB, lineUserId);

  if (env.OWNER_LINE_USER_ID) {
    await pushMessage(
      env.LINE_CHANNEL_ACCESS_TOKEN,
      env.OWNER_LINE_USER_ID,
      `かまってリクエスト: ${minutes}分\n残り時間: ${formatMinutes(
        result.afterRemaining
      )}`
    );
  }

  return {
    message:
      `${minutes}分を使いました。\n` +
      `残り時間は ${formatMinutes(result.afterRemaining)} です。`,
    quickReply: getQuickReply("partner"),
  };
}

async function processOwnerCommand(env, lineUserId, normalized, rawText) {
  const setMatch = normalized.match(/^設定\s+(\d+)$/);
  const addMatch = normalized.match(/^追加\s+(\d+)$/);
  const adjustMatch = normalized.match(/^調整\s+(-?\d+)$/);

  if (setMatch) {
    const minutes = Number(setMatch[1]);
    const result = await setWallet(env.DB, lineUserId, minutes, rawText);

    return {
      message:
        `残り時間を ${formatMinutes(result.afterRemaining)} に設定しました。\n` +
        `総追加時間は ${formatMinutes(result.totalMinutes)} です。`,
      quickReply: getQuickReply("owner"),
    };
  }

  if (addMatch) {
    const minutes = Number(addMatch[1]);
    const result = await updateWallet(env.DB, {
      actorLineUserId: lineUserId,
      eventType: "add",
      minutes,
      rawMessage: rawText,
    });

    return {
      message:
        `${minutes}分を追加しました。\n` +
        `残り時間は ${formatMinutes(result.afterRemaining)} です。`,
      quickReply: getQuickReply("owner"),
    };
  }

  if (adjustMatch) {
    const minutes = Number(adjustMatch[1]);
    const result = await updateWallet(env.DB, {
      actorLineUserId: lineUserId,
      eventType: "adjust",
      minutes,
      rawMessage: rawText,
    });

    if (!result.ok) {
      return {
        message:
          "残り時間が0分未満になる調整はできません。\n" +
          `現在の残り時間は ${formatMinutes(result.beforeRemaining)} です。`,
        quickReply: getQuickReply("owner"),
      };
    }

    return {
      message:
        `${minutes}分を調整しました。\n` +
        `残り時間は ${formatMinutes(result.afterRemaining)} です。`,
      quickReply: getQuickReply("owner"),
    };
  }

  return {
    message:
      "使える操作は「残り」「追加」「調整」「設定」です。\n" +
      "例: 追加 60 / 調整 -10 / 設定 180",
    quickReply: getQuickReply("owner"),
  };
}

function normalizeText(text) {
  return text.replace(/[　\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function isStatusCommand(text) {
  return ["残り", "残高", "確認", "残り時間"].includes(text);
}

function parseUseMinutes(text) {
  const directMatch = text.match(/^(\d+)\s*分?$/);
  if (directMatch) return Number(directMatch[1]);

  const useMatch = text.match(/^使用\s+(\d+)$/);
  if (useMatch) return Number(useMatch[1]);

  return null;
}

function parseMinutesOnly(text) {
  const match = text.match(/^(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function updateWallet(db, params) {
  const walletBefore = await getWallet(db);
  const beforeRemaining = walletBefore.remaining_minutes;

  let totalMinutes = walletBefore.total_minutes;
  let afterRemaining = walletBefore.remaining_minutes;

  if (params.eventType === "add") {
    totalMinutes += params.minutes;
    afterRemaining += params.minutes;
  } else if (params.eventType === "use") {
    afterRemaining -= params.minutes;

    if (afterRemaining < 0) {
      return {
        ok: false,
        beforeRemaining,
      };
    }
  } else if (params.eventType === "adjust") {
    afterRemaining += params.minutes;

    if (afterRemaining < 0) {
      return {
        ok: false,
        beforeRemaining,
      };
    }
  }

  await saveWallet(db, totalMinutes, afterRemaining);
  await insertEvent(db, {
    lineUserId: params.actorLineUserId,
    eventType: params.eventType,
    minutes: params.minutes,
    beforeRemaining,
    afterRemaining,
    note: params.eventType,
    rawMessage: params.rawMessage,
  });

  return {
    ok: true,
    totalMinutes,
    beforeRemaining,
    afterRemaining,
  };
}

async function setWallet(db, lineUserId, minutes, rawMessage) {
  const walletBefore = await getWallet(db);
  const beforeRemaining = walletBefore.remaining_minutes;

  await saveWallet(db, minutes, minutes);
  await insertEvent(db, {
    lineUserId,
    eventType: "set",
    minutes,
    beforeRemaining,
    afterRemaining: minutes,
    note: "set",
    rawMessage,
  });

  return {
    totalMinutes: minutes,
    beforeRemaining,
    afterRemaining: minutes,
  };
}

async function saveWallet(db, totalMinutes, remainingMinutes) {
  await db
    .prepare(
      `
      UPDATE wallet
      SET
        total_minutes = ?,
        remaining_minutes = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      `
    )
    .bind(totalMinutes, remainingMinutes)
    .run();
}

async function insertEvent(db, event) {
  await db
    .prepare(
      `
      INSERT INTO events (
        line_user_id,
        event_type,
        minutes,
        before_remaining_minutes,
        after_remaining_minutes,
        note,
        raw_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      event.lineUserId,
      event.eventType,
      event.minutes,
      event.beforeRemaining,
      event.afterRemaining,
      event.note,
      event.rawMessage
    )
    .run();
}

async function upsertUser(db, lineUserId, role) {
  await db
    .prepare(
      `
      INSERT INTO users (
        line_user_id,
        role
      ) VALUES (?, ?)
      ON CONFLICT(line_user_id) DO UPDATE SET
        role = excluded.role,
        updated_at = CURRENT_TIMESTAMP
      `
    )
    .bind(lineUserId, role)
    .run();
}

async function getUserState(db, lineUserId) {
  await ensureUserStatesTable(db);

  const row = await db
    .prepare(
      `
      SELECT state
      FROM user_states
      WHERE line_user_id = ?
      `
    )
    .bind(lineUserId)
    .first();

  return row?.state || null;
}

async function setUserState(db, lineUserId, state) {
  await ensureUserStatesTable(db);

  await db
    .prepare(
      `
      INSERT INTO user_states (
        line_user_id,
        state
      ) VALUES (?, ?)
      ON CONFLICT(line_user_id) DO UPDATE SET
        state = excluded.state,
        updated_at = CURRENT_TIMESTAMP
      `
    )
    .bind(lineUserId, state)
    .run();
}

async function clearUserState(db, lineUserId) {
  await ensureUserStatesTable(db);

  await db
    .prepare(
      `
      DELETE FROM user_states
      WHERE line_user_id = ?
      `
    )
    .bind(lineUserId)
    .run();
}

async function ensureUserStatesTable(db) {
  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS user_states (
        line_user_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
      `
    )
    .run();
}

async function getWallet(db) {
  const wallet = await db
    .prepare(
      `
      SELECT
        total_minutes,
        remaining_minutes
      FROM wallet
      WHERE id = 1
      `
    )
    .first();

  if (!wallet) {
    await db
      .prepare(
        `
        INSERT INTO wallet (
          id,
          total_minutes,
          remaining_minutes
        ) VALUES (1, 0, 0)
        `
      )
      .run();

    return {
      total_minutes: 0,
      remaining_minutes: 0,
    };
  }

  return wallet;
}

function getQuickReply(role) {
  if (role === "partner") {
    return {
      items: [
        quickReplyText("残りを見る", "残り"),
        quickReplyText("かまちょ", "かまちょ"),
      ],
    };
  }

  return {
    items: [
      quickReplyText("残りを見る", "残り"),
      quickReplyText("30分追加", "追加 30"),
      quickReplyText("60分追加", "追加 60"),
      quickReplyText("30分減らす", "調整 -30"),
    ],
  };
}

function quickReplyText(label, text) {
  return {
    type: "action",
    action: {
      type: "message",
      label,
      text,
    },
  };
}

function formatStatus(wallet) {
  return (
    `残り時間は ${formatMinutes(wallet.remaining_minutes)} です。\n` +
    `総追加時間は ${formatMinutes(wallet.total_minutes)} です。`
  );
}

function formatMinutes(minutes) {
  const safeMinutes = Math.max(0, Number(minutes) || 0);
  const hours = Math.floor(safeMinutes / 60);
  const rest = safeMinutes % 60;

  if (hours === 0) return `${rest}分`;
  if (rest === 0) return `${hours}時間`;
  return `${hours}時間${rest}分`;
}

async function replyMessage(channelAccessToken, replyToken, text, quickReply) {
  const message = {
    type: "text",
    text,
  };

  if (quickReply) {
    message.quickReply = quickReply;
  }

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${channelAccessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [message],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("LINE reply error:", response.status, errorText);
  }
}

async function pushMessage(channelAccessToken, to, text) {
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${channelAccessToken}`,
    },
    body: JSON.stringify({
      to,
      messages: [
        {
          type: "text",
          text,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("LINE push error:", response.status, errorText);
  }
}

async function verifyLineSignature(bodyText, channelSecret, signature) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(bodyText)
  );

  const expectedSignature = arrayBufferToBase64(digest);

  return timingSafeEqual(expectedSignature, signature);
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

async function renderHomePage(env) {
  const wallet = await getWallet(env.DB);
  const remaining = wallet.remaining_minutes;
  const total = wallet.total_minutes;
  const percent = total > 0 ? Math.min(100, Math.round((remaining / total) * 100)) : 0;

  return new Response(
    `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>かまっちょ時間</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #24312f;
      --muted: #66736f;
      --paper: #fffaf7;
      --line: #ead9d1;
      --mint: #8fd3bd;
      --rose: #ff8fa3;
      --lemon: #ffd166;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        linear-gradient(135deg, rgba(255, 143, 163, 0.14) 0 25%, transparent 25% 100%),
        linear-gradient(225deg, rgba(143, 211, 189, 0.18) 0 22%, transparent 22% 100%),
        linear-gradient(180deg, #fffaf7 0%, #f5fbf7 100%);
    }

    main {
      width: min(920px, calc(100% - 32px));
      min-height: 100vh;
      margin: 0 auto;
      display: grid;
      place-items: center;
      padding: 28px 0;
    }

    .shell {
      width: 100%;
      display: grid;
      gap: 18px;
    }

    .hero {
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.78);
      box-shadow: 0 18px 48px rgba(70, 47, 39, 0.10);
    }

    .label {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 14px;
      font-weight: 700;
    }

    h1 {
      margin: 0;
      font-size: clamp(34px, 8vw, 72px);
      line-height: 1.05;
      letter-spacing: 0;
    }

    .time {
      display: inline-flex;
      align-items: baseline;
      gap: 8px;
      margin-top: 18px;
      font-weight: 800;
      color: #dd5f78;
    }

    .time strong {
      font-size: clamp(48px, 16vw, 128px);
      line-height: 0.95;
      letter-spacing: 0;
    }

    .time span {
      font-size: clamp(22px, 5vw, 44px);
    }

    .meter {
      height: 18px;
      margin-top: 20px;
      border-radius: 999px;
      overflow: hidden;
      background: #f0e5df;
      border: 1px solid var(--line);
    }

    .meter > div {
      width: ${percent}%;
      height: 100%;
      background: linear-gradient(90deg, var(--rose), var(--lemon), var(--mint));
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .stat {
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.74);
    }

    .stat p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }

    .stat strong {
      display: block;
      margin-top: 6px;
      font-size: 24px;
    }

    @media (max-width: 560px) {
      main { width: min(100% - 20px, 920px); }
      .hero { padding: 22px; }
      .stats { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <section class="shell" aria-label="かまっちょ時間">
      <div class="hero">
        <p class="label">かまっちょ時間</p>
        <h1>残り時間</h1>
        <div class="time">
          <strong>${remaining}</strong>
          <span>分</span>
        </div>
        <div class="meter" aria-label="残り時間の割合">
          <div></div>
        </div>
      </div>
      <div class="stats">
        <div class="stat">
          <p>残り</p>
          <strong>${formatMinutes(remaining)}</strong>
        </div>
        <div class="stat">
          <p>総追加</p>
          <strong>${formatMinutes(total)}</strong>
        </div>
      </div>
    </section>
  </main>
</body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    }
  );
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
