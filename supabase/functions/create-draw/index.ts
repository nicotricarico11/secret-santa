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

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
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

function normalizeName(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim();
}

function normalizePhone(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  // Permit common visual separators, but no letters or extensions.
  if (!/^[+\d\s().-]+$/.test(raw)) {
    throw new Error("Een telefoonnummer bevat ongeldige tekens.");
  }

  let compact = raw.replace(/[\s().-]/g, "");
  if (compact.startsWith("00")) compact = `+${compact.slice(2)}`;

  if (!/^\+?\d+$/.test(compact)) {
    throw new Error("Ongeldig telefoonnummer.");
  }

  const digits = compact.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    throw new Error("Een telefoonnummer moet 7 tot 15 cijfers bevatten.");
  }

  // Store in one normalized form so formatting cannot bypass duplicate checks.
  return `+${digits}`;
}

type Person = {
  id: string;
  name: string;
  phone: string | null;
};

function buildMatching(
  people: Person[],
  excludedPairs: Set<string>,
): Map<string, string> {
  const ids = people.map((person) => person.id);
  const candidates = new Map<string, string[]>();

  for (const giverId of ids) {
    const possible = ids.filter((recipientId) => {
      if (giverId === recipientId) return false;
      const pair = [giverId, recipientId].sort().join(":");
      return !excludedPairs.has(pair);
    });
    candidates.set(giverId, secureShuffle(possible));
  }

  // Try the most constrained givers first; randomize ties and candidate order.
  const giverOrder = secureShuffle(ids).sort(
    (a, b) => candidates.get(a)!.length - candidates.get(b)!.length,
  );

  // Kuhn's augmenting-path algorithm finds a maximum bipartite matching.
  const recipientToGiver = new Map<string, string>();

  const tryAssign = (giverId: string, seenRecipients: Set<string>): boolean => {
    for (const recipientId of candidates.get(giverId)!) {
      if (seenRecipients.has(recipientId)) continue;
      seenRecipients.add(recipientId);

      const previousGiver = recipientToGiver.get(recipientId);
      if (!previousGiver || tryAssign(previousGiver, seenRecipients)) {
        recipientToGiver.set(recipientId, giverId);
        return true;
      }
    }
    return false;
  };

  for (const giverId of giverOrder) {
    if (!tryAssign(giverId, new Set<string>())) {
      throw new Error(
        "Er bestaat geen geldige trekking met deze uitsluitingen. Pas de uitsluitingen aan.",
      );
    }
  }

  const giverToRecipient = new Map<string, string>();
  for (const [recipientId, giverId] of recipientToGiver) {
    giverToRecipient.set(giverId, recipientId);
  }

  if (giverToRecipient.size !== people.length) {
    throw new Error(
      "Er bestaat geen volledige geldige trekking. Pas de uitsluitingen aan.",
    );
  }

  return giverToRecipient;
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
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!url || !serviceKey || !anonKey) {
      console.error("Missing Supabase environment variable.");
      return json({ error: "Serverconfiguratie ontbreekt." }, 500);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Niet ingelogd." }, 401);
    }

    const authClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      return json({ error: "Ongeldige login." }, 401);
    }

    const db = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: admin, error: adminError } = await db
      .from("admin_users")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) {
      console.error("Admin lookup failed:", adminError);
      return json({ error: "Beheerdersrechten konden niet worden gecontroleerd." }, 500);
    }

    if (!admin) {
      return json({ error: "Geen beheerrechten." }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Ongeldige aanvraag." }, 400);
    }

    const eventName = normalizeName(body.eventName);
    const peopleInput = body.participants;
    const requestKey = body.requestKey;
    const exclusionsInput = body.exclusions ?? [];

    if (
      !eventName ||
      eventName.length > 120 ||
      !Array.isArray(peopleInput) ||
      peopleInput.length < 2 ||
      peopleInput.length > 100
    ) {
      return json({
        error: "Vul een naam voor de loting en minstens 2 en maximaal 100 deelnemers in.",
      }, 400);
    }

    if (
      typeof requestKey !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)
    ) {
      return json({ error: "Ongeldige aanvraag-ID. Probeer opnieuw." }, 400);
    }

    if (!Array.isArray(exclusionsInput) || exclusionsInput.length > 4950) {
      return json({ error: "Ongeldige uitsluitingen." }, 400);
    }

    let people: Person[];
    try {
      people = peopleInput.map((person: any) => ({
        id: crypto.randomUUID(),
        name: normalizeName(person?.name),
        phone: normalizePhone(person?.phone),
      }));
    } catch (error) {
      return json({
        error: error instanceof Error ? error.message : "Ongeldig telefoonnummer.",
      }, 400);
    }

    if (people.some((person) => !person.name || person.name.length > 100)) {
      return json({ error: "Elke deelnemersnaam moet 1 tot 100 tekens bevatten." }, 400);
    }

    const nameMap = new Map<string, Person>();
    for (const person of people) {
      const key = person.name.toLocaleLowerCase();
      if (nameMap.has(key)) {
        return json({ error: "Elke deelnemer moet een unieke naam hebben." }, 400);
      }
      nameMap.set(key, person);
    }

    const phoneSet = new Set<string>();
    for (const person of people) {
      if (!person.phone) continue;
      const digits = person.phone.replace(/\D/g, "");
      if (phoneSet.has(digits)) {
        return json({
          error: "Een telefoonnummer mag maar één keer voorkomen binnen dezelfde loting.",
        }, 400);
      }
      phoneSet.add(digits);
    }

    const exclusionRows: Array<{ person_a_id: string; person_b_id: string }> = [];
    const excludedPairs = new Set<string>();
    const seenExclusions = new Set<string>();

    for (const item of exclusionsInput as any[]) {
      const nameA = normalizeName(item?.personA);
      const nameB = normalizeName(item?.personB);

      if (!nameA || !nameB) {
        return json({ error: "Elke uitsluiting moet twee deelnemers bevatten." }, 400);
      }

      const personA = nameMap.get(nameA.toLocaleLowerCase());
      const personB = nameMap.get(nameB.toLocaleLowerCase());

      if (!personA || !personB) {
        return json({
          error: `Onbekende deelnemer in uitsluiting: ${nameA} / ${nameB}. Gebruik exact de deelnemersnamen.`,
        }, 400);
      }

      if (personA.id === personB.id) {
        return json({ error: "Een deelnemer kan niet zichzelf uitsluiten." }, 400);
      }

      const sortedIds = [personA.id, personB.id].sort();
      const pairKey = sortedIds.join(":");

      if (seenExclusions.has(pairKey)) {
        return json({
          error: `De uitsluiting ${personA.name} – ${personB.name} staat dubbel vermeld.`,
        }, 400);
      }

      seenExclusions.add(pairKey);
      excludedPairs.add(pairKey);
      exclusionRows.push({
        person_a_id: sortedIds[0],
        person_b_id: sortedIds[1],
      });
    }

    let giverToRecipient: Map<string, string>;
    try {
      giverToRecipient = buildMatching(people, excludedPairs);
    } catch (error) {
      return json({
        error: error instanceof Error
          ? error.message
          : "Er bestaat geen geldige trekking met deze uitsluitingen.",
      }, 422);
    }

    const links: Array<{ name: string; phone: string | null; link: string }> = [];
    const assignmentRows: Array<{
      giver_id: string;
      recipient_id: string;
      token_hash: string;
    }> = [];

    for (const giver of people) {
      const recipientId = giverToRecipient.get(giver.id);
      if (!recipientId) {
        return json({ error: "De trekking kon niet volledig worden gemaakt." }, 500);
      }

      const token = randomToken();
      assignmentRows.push({
        giver_id: giver.id,
        recipient_id: recipientId,
        token_hash: await hashToken(token),
      });

      const baseUrl = SITE_URL.endsWith("/") ? SITE_URL : `${SITE_URL}/`;
      const link = new URL(`?token=${token}`, baseUrl).toString();

      links.push({
        name: giver.name,
        phone: giver.phone,
        link,
      });
    }

    const { error: drawError } = await db.rpc("create_secret_santa_draw", {
      p_owner_id: user.id,
      p_event_name: eventName,
      p_request_key: requestKey,
      p_participants: people.map(({ id, name, phone }) => ({ id, name, phone })),
      p_assignments: assignmentRows,
      p_exclusions: exclusionRows,
    });

    if (drawError) {
      console.error("Atomic draw RPC failed:", drawError);

      if (drawError.code === "23505") {
        return json({
          error: "Deze aanvraag is al verwerkt of bestaat al. Ververs de pagina en probeer opnieuw.",
        }, 409);
      }

      return json({
        error: "De loting kon niet veilig worden opgeslagen. Er zijn geen gedeeltelijke resultaten bewaard.",
      }, 500);
    }

    return json({
      success: true,
      eventName,
      links,
    });
  } catch (error) {
    console.error("Unexpected create-draw error:", error);
    return json({ error: "De loting kon niet worden voltooid." }, 500);
  }
});
