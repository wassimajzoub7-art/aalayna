/* Shared store configuration. The anon key is public by design: every phone that
   scans a QR uses it. Access is decided per venue key by row-level security in
   Postgres (see supabase/migration.sql), never by this file. No secret belongs here. */
window.AalaynaConfig = {
  supabaseUrl: 'https://xeqbkamwucqplvoavhyd.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhlcWJrYW13dWNxcGx2b2F2aHlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwMjM3MzksImV4cCI6MjEwNDU5OTczOX0.ZsbdzscWG2OoVZayVnTHWixsgxw96SQMO4Ls7iJS6aI'
};
