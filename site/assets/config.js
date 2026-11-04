/* Public settings for the static site. Both values are safe to publish: the
 * anon key only reaches the database functions in supabase/migrations, which
 * enforce every rule themselves.
 *
 * Leave them blank to run the song board in demo mode (stored in this
 * browser only), which is handy for local previews.
 */
window.KT_CONFIG = {
  supabaseUrl: '',      // e.g. 'https://abcd1234.supabase.co'
  supabaseAnonKey: ''   // Project Settings → API → anon public key
};
