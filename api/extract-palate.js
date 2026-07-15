const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const EXTRACTION_SYSTEM = `You are a wine preference extractor for Wini, an AI wine guide.

Analyse the exchange and extract preference signals.
Return ONLY a JSON object with fields that have new information. Omit unchanged fields entirely.
Return {} if nothing new was revealed.

Rules:
- Always capture context alongside the preference (occasion, food, mood, situation)
- Never guess beyond what was clearly stated
- For array fields: return only NEW items to append
- Treat different contexts as valid separate entries, not contradictions (bold red for BBQ and light white for fish are both correct)
- Set last_mentioned to todayDate for every extracted item
- For dislikes: capture the context carefully (hates oak generally vs only dislikes oaked Chardonnay are very different)

Fields to extract:
styles, grapes_loved, grapes_disliked, regions_loved, regions_disliked, budget, dislikes, bottle_shop

Return raw JSON only. No markdown. No explanation.`;

function supabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// Merge extracted fields into the existing profile.
function mergeProfiles(existing, extracted) {
  const merged = { ...existing };

  const ARRAY_FIELDS = [
    'styles', 'grapes_loved', 'grapes_disliked',
    'regions_loved', 'regions_disliked', 'budget', 'dislikes',
  ];
  // The primary key for dedup within each array field
  const KEY_MAP = {
    styles:           'style',
    grapes_loved:     'grape',
    grapes_disliked:  'grape',
    regions_loved:    'region',
    regions_disliked: 'region',
    dislikes:         'dislike',
  };

  for (const field of ARRAY_FIELDS) {
    if (!extracted[field] || !Array.isArray(extracted[field])) continue;

    const arr = Array.isArray(merged[field]) ? [...merged[field]] : [];
    const pk  = KEY_MAP[field]; // undefined for 'budget'

    for (const newItem of extracted[field]) {
      let idx;
      if (pk) {
        // Duplicate = same value AND same context
        idx = arr.findIndex(
          i => i[pk]?.toLowerCase() === newItem[pk]?.toLowerCase()
            && i.context?.toLowerCase() === newItem.context?.toLowerCase()
        );
      } else {
        // budget: same context only
        idx = arr.findIndex(
          i => i.context?.toLowerCase() === newItem.context?.toLowerCase()
        );
      }

      if (idx >= 0) {
        arr[idx] = { ...arr[idx], ...newItem }; // update last_mentioned + any changed fields
      } else {
        arr.push(newItem);
      }
    }

    // Cap at 20 — drop the item with the oldest last_mentioned
    if (arr.length > 20) {
      arr.sort((a, b) => new Date(a.last_mentioned) - new Date(b.last_mentioned));
      arr.splice(0, arr.length - 20);
    }

    merged[field] = arr;
  }

  // Scalar field
  if (extracted.bottle_shop !== undefined) {
    merged.bottle_shop = extracted.bottle_shop;
  }

  return merged;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { userId, userMessage, assistantMessage, todayDate } = req.body || {};
  if (!userId || !userMessage || !assistantMessage) return res.status(400).end();

  try {
    const db = supabase();

    // Fetch current profile (may not exist yet — maybeSingle returns null instead of throwing)
    const { data: row } = await db
      .from('palate_profile')
      .select('profile')
      .eq('user_id', userId)
      .maybeSingle();

    const currentProfile = row?.profile || {};

    // Call Haiku for extraction
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: EXTRACTION_SYSTEM,
      messages: [{
        role: 'user',
        content:
          `Today's date: ${todayDate}\n` +
          `Current profile: ${JSON.stringify(currentProfile)}\n` +
          `User said: ${userMessage}\n` +
          `Wini replied: ${assistantMessage}\n` +
          `Extract new preference signals only.`,
      }],
    });

    const raw = msg.content[0]?.text?.trim() || '{}';
    let extracted;
    try {
      extracted = JSON.parse(raw);
    } catch {
      return res.status(200).end(); // model returned bad JSON — silent skip
    }

    if (!extracted || Object.keys(extracted).length === 0) return res.status(200).end();

    const merged = mergeProfiles(currentProfile, extracted);

    await db
      .from('palate_profile')
      .upsert(
        { user_id: userId, profile: merged, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );

    console.log(`extract-palate: upserted profile for user ${userId}`);
    return res.status(200).end();
  } catch (err) {
    console.error('extract-palate error:', err.message);
    return res.status(200).end(); // always silent — never break the client
  }
};
