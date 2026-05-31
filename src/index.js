export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        message: "LINE time wallet bot is running.",
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

  for (const event of body.events) {
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

  await upsertUser(env.DB, lineUserId);

  const result = await processCommand(env.DB, lineUserId, text);

  await replyMessage(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, result.message);
}

async function processCommand(db, lineUserId, text) {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (normalized === "テスト") {
    return {
      message: "ありがとうございます！",
    };
  }

  if (normalized === "残り" || normalized === "残高" || normalized === "確認") {
    const wallet = await getWallet(db);

    return {
      message:
        `現在の残り時間は ${wallet.remaining_minutes} 分です。\n` +
        `総追加時間は ${wallet.total_minutes} 分です。`,
    };
  }

  const match = normalized.match(/^(追加|使用|調整)\s+(-?\d+)$/);

  if (!match) {
    return {
      message:
        "使い方：\n" +
        "追加 60\n" +
        "使用 30\n" +
        "調整 -10\n" +
        "残り",
    };
  }

  const command = match[1];
  const minutes = Number(match[2]);

  if (!Number.isInteger(minutes)) {
    return {
      message: "分数は整数で入力してください。",
    };
  }

  if ((command === "追加" || command === "使用") && minutes <= 0) {
    return {
      message: "追加・使用は1分以上で入力してください。",
    };
  }

  const walletBefore = await getWallet(db);
  const beforeRemaining = walletBefore.remaining_minutes;

  let totalMinutes = walletBefore.total_minutes;
  let afterRemaining = walletBefore.remaining_minutes;
  let eventType;

  if (command === "追加") {
    totalMinutes += minutes;
    afterRemaining += minutes;
    eventType = "add";
  } else if (command === "使用") {
    afterRemaining -= minutes;
    eventType = "use";

    if (afterRemaining < 0) {
      return {
        message:
          `残り時間が足りません。\n` +
          `現在の残り時間は ${beforeRemaining} 分です。`,
      };
    }
  } else {
    afterRemaining += minutes;
    eventType = "adjust";
  }

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
    .bind(totalMinutes, afterRemaining)
    .run();

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
      lineUserId,
      eventType,
      minutes,
      beforeRemaining,
      afterRemaining,
      command,
      text
    )
    .run();

  if (command === "追加") {
    return {
      message:
        `${minutes}分を追加しました。\n` +
        `残り時間：${afterRemaining}分`,
    };
  }

  if (command === "使用") {
    return {
      message:
        `${minutes}分を使用しました。\n` +
        `残り時間：${afterRemaining}分`,
    };
  }

  return {
    message:
      `${minutes}分を調整しました。\n` +
      `残り時間：${afterRemaining}分`,
  };
}

async function upsertUser(db, lineUserId) {
  await db
    .prepare(
      `
      INSERT INTO users (
        line_user_id,
        role
      ) VALUES (?, 'member')
      ON CONFLICT(line_user_id) DO UPDATE SET
        updated_at = CURRENT_TIMESTAMP
      `
    )
    .bind(lineUserId)
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

async function replyMessage(channelAccessToken, replyToken, text) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${channelAccessToken}`,
    },
    body: JSON.stringify({
      replyToken,
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
    console.error("LINE reply error:", response.status, errorText);
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
