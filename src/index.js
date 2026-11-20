
import { buildPushPayload } from "@block65/webcrypto-web-push";

const ALLOWED_ORIGIN = "https://ivoryvows.github.io";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(data, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json"
    }
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (origin !== ALLOWED_ORIGIN) {
      return json({ error: "Origin not allowed" }, 403, origin);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin)
      });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/vapid-public-key") {
      return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, origin);
    }

    if (request.method === "POST" && url.pathname === "/subscribe") {
      try {
        const body = await request.json();
        const sub = body.subscription;
        const interval = Number(body.interval_minutes || 60);

        if (
          !sub?.endpoint?.startsWith("https://") ||
          !sub?.keys?.p256dh ||
          !sub?.keys?.auth ||
          !Number.isInteger(interval) ||
          interval < 15 ||
          interval > 240
        ) {
          return json({ error: "Invalid subscription or interval" }, 400, origin);
        }

        const now = Math.floor(Date.now() / 1000);

        await env.DB.prepare(`
          INSERT INTO push_subscriptions
          (endpoint, p256dh, auth, interval_minutes, enabled, next_reminder_at)
          VALUES (?, ?, ?, ?, 1, ?)
          ON CONFLICT(endpoint) DO UPDATE SET
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            interval_minutes = excluded.interval_minutes,
            enabled = 1,
            next_reminder_at = excluded.next_reminder_at
        `).bind(
          sub.endpoint,
          sub.keys.p256dh,
          sub.keys.auth,
          interval,
          now + interval * 60
        ).run();

        return json({ success: true }, 200, origin);
      } catch (error) {
        return json({ error: "Could not save subscription" }, 500, origin);
      }
    }

    if (request.method === "POST" && url.pathname === "/unsubscribe") {
      try {
        const body = await request.json();

        if (!body.endpoint) {
          return json({ error: "Missing endpoint" }, 400, origin);
        }

        await env.DB.prepare(
          "DELETE FROM push_subscriptions WHERE endpoint = ?"
        ).bind(body.endpoint).run();

        return json({ success: true }, 200, origin);
      } catch (error) {
        return json({ error: "Could not unsubscribe" }, 500, origin);
      }
    }

    return json({ error: "Not found" }, 404, origin);
  },

  async scheduled(event, env, ctx) {
    const now = Math.floor(Date.now() / 1000);

    const result = await env.DB.prepare(`
      SELECT id, endpoint, p256dh, auth, interval_minutes
      FROM push_subscriptions
      WHERE enabled = 1 AND next_reminder_at <= ?
    `).bind(now).all();

    for (const row of result.results || []) {
      const subscription = {
        endpoint: row.endpoint,
        expirationTime: null,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth
        }
      };

      try {
        const payload = await buildPushPayload(
          {
            data: JSON.stringify({
              title: "HydraFit 💧",
              body: "Time to drink some water!",
              url: "https://ivoryvows.github.io/HydraFit/"
            }),
            options: { ttl: 60 }
          },
          subscription,
          {
            subject: env.VAPID_SUBJECT,
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY
          }
        );

        const response = await fetch(row.endpoint, payload);

        if (response.status === 404 || response.status === 410) {
          await env.DB.prepare(
            "DELETE FROM push_subscriptions WHERE id = ?"
          ).bind(row.id).run();
          continue;
        }
      } catch (error) {
        // A failed delivery will be retried at the next interval.
      }

      const nextTime = now + row.interval_minutes * 60;

      await env.DB.prepare(
        "UPDATE push_subscriptions SET next_reminder_at = ? WHERE id = ?"
      ).bind(nextTime, row.id).run();
    }
  }
};
