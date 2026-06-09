const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    const adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { error } = await adminClient.auth.admin.deleteUser(userId);
    if (error) throw error;

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('delete-account error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
