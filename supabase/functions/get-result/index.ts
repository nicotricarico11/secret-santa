
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
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

async function hashToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const token = body.token;

    if (
      typeof token !== "string" ||
      !/^[a-f0-9]{64}$/.test(token)
    ) {
      return json({
        error: "Deze geheime link is niet geldig."
      }, 400);
    }

    const tokenHash = await hashToken(token);

    const { data: assignment, error } = await db
      .from("assignments")
      .select("recipient_id")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (error || !assignment) {
      return json({
        error: "Deze geheime link is niet geldig."
      }, 404);
    }

    const { data: recipient, error: personError } = await db
      .from("participants")
      .select("name")
      .eq("id", assignment.recipient_id)
      .single();

    if (personError || !recipient) {
      return json({
        error: "Resultaat niet gevonden."
      }, 404);
    }

    return json({
      success: true,
      recipient: recipient.name
    });

  } catch (error) {
    console.error(error);

    return json({
      error: "Er ging iets mis bij het ophalen van je resultaat."
    }, 500);
  }
});
