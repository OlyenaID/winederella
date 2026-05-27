module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // SUPABASE_URL and SUPABASE_ANON_KEY are safe to expose —
  // the anon key is designed to be public; RLS policies protect the data.
  return res.status(200).json({
    supabaseUrl:      process.env.SUPABASE_URL      || '',
    supabaseAnonKey:  process.env.SUPABASE_ANON_KEY || '',
  });
};
