import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SITE_URL = Deno.env.get("SITE_URL") ?? "";
const allowedOrigin = (() => {
  try {
    return new URL(SITE_URL).origin;
  } catch {
    return "";
  }
})();

const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin || "null",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });

async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  if (!allowedOrigin) {
    console.error("SITE_URL is missing or invalid.");
    return json({ error: "Serverconfiguratie ontbreekt." }, 500);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Missing Supabase environment variable.");
      return json({ error: "Serverconfiguratie ontbreekt." }, 500);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Deze geheime link is niet geldig." }, 400);
    }

    const token = body.token;
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
      return json({ error: "Deze geheime link is niet geldig." }, 400);
    }

    const db = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const tokenHash = await hashToken(token);

    const { data: assignment, error: assignmentError } = await db
      .from("assignments")
      .select("recipient_id")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (assignmentError) {
      console.error("Assignment lookup failed:", assignmentError);
      return json({ error: "Resultaat kon niet worden opgehaald." }, 500);
    }

    if (!assignment) {
      return json({ error: "Deze geheime link is niet geldig." }, 404);
    }

    const { data: recipient, error: personError } = await db
      .from("participants")
      .select("name")
      .eq("id", assignment.recipient_id)
      .maybeSingle();

    if (personError || !recipient) {
      console.error("Recipient lookup failed:", personError);
      return json({ error: "Resultaat niet gevonden." }, 404);
    }

    return json({
      success: true,
      recipient: recipient.name,
    });
  } catch (error) {
    console.error("Unexpected get-result error:", error);
    return json({
      error: "Er ging iets mis bij het ophalen van je resultaat.",
    }, 500);
  }
});
