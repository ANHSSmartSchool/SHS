/* ANHS SMARTSCHOOL - SUPABASE CONFIG
   Replace these placeholders with values from Supabase > Project Settings > API.
*/
const SUPABASE_URL = "https://ycfjljdarwaaclfxyujf.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InljZmpsamRhcndhYWNsZnh5dWpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MjY2NjMsImV4cCI6MjEwNTMwMjY2M30.sBdbE3YdVCJcW3y_UkQCXY2SH0yu9_7Mx7NdIJaUibk";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
