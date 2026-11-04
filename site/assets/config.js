/* Public settings for the static site. Both values are safe to publish: the
 * key only reaches the database functions in supabase/migrations, which
 * enforce every rule themselves (tables have RLS on and no grants).
 *
 * The key is the project's legacy `anon` key (a JWT), on purpose: the `songs`
 * Edge Function runs with verify_jwt on, and song search is called before a
 * guest signs in, so it must carry a JWT. A `sb_publishable_...` key is not a
 * JWT and would get a 401. To switch to publishable keys later: upgrade
 * supabase-js, set verify_jwt = false for `songs` in supabase/config.toml,
 * and check the apikey header inside the function.
 *
 * Blank both values to run the song board in demo mode (stored in this
 * browser only), which is handy for local previews.
 */
window.KT_CONFIG = {
  supabaseUrl: 'https://pzmeppjcvsjkneducqvd.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6bWVwcGpjdnNqa25lZHVjcXZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM4MDE5NDUsImV4cCI6MjEwOTM3Nzk0NX0.OonktgXp0FROF7jwhPavlDMKNtfKatYdX1d6Lf_xfgs'
};
