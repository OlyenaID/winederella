module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // SUPABASE_URL, SUPABASE_ANON_KEY, and POSTHOG_KEY are all safe to expose —
  // designed to be public; RLS policies protect Supabase data, and PostHog's
  // project key is capture-only, same as a GA tracking ID.
  return res.status(200).json({
    supabaseUrl:      process.env.SUPABASE_URL      || '',
    supabaseAnonKey:  process.env.SUPABASE_ANON_KEY || '',
    posthogKey:       process.env.POSTHOG_KEY        || '',
  });
};
