
import { buildPushPayload } from "@block65/webcrypto-web-push";

const cors = {
  "Access-Control-Allow-Origin": "https://ivoryvows.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === "/vapid-public-key" && request.method === "GET") {
      return reply({ publicKey: env.VAPID_PUBLIC_KEY });
    }

    if (url.pathname === "/subscribe" && request.method === "POST") {
      try {
        const body = await request.json();
        const sub = body.subscription;
        const interval = Math.max(1, Number(body.interval_minutes) || 60);

        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
          return reply({ error: "Invalid subscription" }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO push_subscriptions
          (endpoint, p256dh, auth, interval_minutes, timezone, enabled, next_reminder_at)
          VALUES (?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(endpoint) DO UPDATE SET
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            interval_minutes = excluded.interval_minutes,
            timezone = excluded.timezone,
            enabled = 1,
            next_reminder_at = excluded.next_reminder_at
        `).bind(
          sub.endpoint,
          sub.keys.p256dh,
          sub.keys.auth,
          interval,
          body.timezone || "Africa/Kinshasa",
          Date.now() + interval * 60000
        ).run();

        return reply({ success: true });
      } catch (error) {
        return reply({ error: error.message }, 500);
      }
    }

    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      try {
        const body = await request.json();
        await env.DB.prepare(
          "DELETE FROM push_subscriptions WHERE endpoint = ?"
        ).bind(body.endpoint).run();

        return reply({ success: true });
      } catch (error) {
        return reply({ error: error.message }, 500);
      }
    }

    return reply({ error: "Not found" }, 404);
  },

  async scheduled(controller, env, ctx) {
    const now = Date.now();

    const { results } = await env.DB.prepare(`
      SELECT endpoint, p256dh, auth, interval_minutes
      FROM push_subscriptions
      WHERE enabled = 1 AND next_reminder_at <= ?
    `).bind(now).all();

    for (const row of results || []) {
      const subscription = {
        endpoint: row.endpoint,
        expirationTime: null,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth,
        },
      };

      try {
        const payload = await buildPushPayload(
          {
            data: {
              title: "HydraFit 💧",
              body: "Time to drink some water! Stay hydrated.",
              url: "https://ivoryvows.github.io/HydraFit/",
            },
            options: { ttl: 3600 },
          },
          subscription,
          {
            subject: env.VAPID_SUBJECT,
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
          }
        );

        const response = await fetch(row.endpoint, payload);

        if (response.status === 404 || response.status === 410) {
          await env.DB.prepare(
            "DELETE FROM push_subscriptions WHERE endpoint = ?"
          ).bind(row.endpoint).run();
          continue;
        }

        if (!response.ok) {
          throw new Error("Push service returned " + response.status);
        }

        await env.DB.prepare(`
          UPDATE push_subscriptions
          SET next_reminder_at = ?
          WHERE endpoint = ?
        `).bind(
          now + row.interval_minutes * 60000,
          row.endpoint
        ).run();

      } catch (error) {
        console.error("Push error:", error);
      }
    }
  },
};
