
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function hashToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function secureShuffle<T>(items: T[]): T[] {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const limit = 256 - (256 % (i + 1));
    let value: number;

    do {
      value = crypto.getRandomValues(new Uint8Array(1))[0];
    } while (value >= limit);

    const j = value % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const siteUrl = Deno.env.get("SITE_URL")!;

    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      return json({ error: "Niet ingelogd." }, 401);
    }

    const authClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } =
      await authClient.auth.getUser();

    if (authError || !user) {
      return json({ error: "Ongeldige login." }, 401);
    }

    const db = createClient(url, serviceKey);

    
    const { data: admin, error: adminError } = await db
      .from("admin_users")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) {
      console.error("ADMIN QUERY ERROR:", adminError);
      return json({
        error: "Probleem bij controleren beheerdersrechten."
      }, 500);
    }

    if (!admin) {
      console.error("ADMIN NOT FOUND FOR USER:", user.id);
      return json({ error: "Geen beheerrechten." }, 403);
    }

    const body = await req.json();
    const eventName = String(body.eventName || "").trim();
    const people = body.participants;

    if (!eventName || !Array.isArray(people) ||
        people.length < 2 || people.length > 100) {
      return json({
        error: "Vul minstens 2 en maximaal 100 deelnemers in."
      }, 400);
    }

    const cleaned = people.map((p: any) => ({
      name: String(p.name || "").trim(),
      phone: String(p.phone || "").replace(/[^\d+]/g, ""),
    }));

    if (cleaned.some((p: any) => !p.name || p.name.length > 100)) {
      return json({ error: "Ongeldige deelnemersnaam." }, 400);
    }

    const names = cleaned.map((p: any) => p.name.toLowerCase());

    if (new Set(names).size !== names.length) {
      return json({
        error: "Elke deelnemer moet een unieke naam hebben."
      }, 400);
    }

    const { data: event, error: eventError } = await db
      .from("events")
      .insert({ name: eventName })
      .select()
      .single();

    if (eventError) throw eventError;

    const { data: participants, error: peopleError } = await db
      .from("participants")
      .insert(cleaned.map((p: any) => ({
        ...p,
        event_id: event.id,
      })))
      .select();

    if (peopleError) throw peopleError;

    const shuffled = secureShuffle(participants);

    const offset = 1 +
      crypto.getRandomValues(new Uint8Array(1))[0]
      % (shuffled.length - 1);

    const links = [];

    for (let i = 0; i < shuffled.length; i++) {
      const giver = shuffled[i];
      const recipient = shuffled[(i + offset) % shuffled.length];
      const token = randomToken();
      const tokenHash = await hashToken(token);

      const { error } = await db.from("assignments").insert({
        giver_id: giver.id,
        recipient_id: recipient.id,
        token_hash: tokenHash,
      });

      if (error) throw error;

      links.push({
        name: giver.name,
        phone: giver.phone,
        link: `${siteUrl}/?token=${token}`,
      });
    }

    return json({
      success: true,
      eventName,
      links,
    });

  } catch (error) {
    console.error(error);
    return json({
      error: "De loting kon niet worden voltooid."
    }, 500);
  }
});
